// Installment manager web app (add / edit / delete)  ->  npm run web, then open http://localhost:3000
// Connects to Firestore. Locally it reads serviceAccountKey.json; online (Render) it reads the FIREBASE_KEY environment variable
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import admin from "firebase-admin";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOAN_ID = "ford-everest-sport-2020";
const PORT = process.env.PORT || 3000;
// Online hosts set PORT and need 0.0.0.0; on your own computer keep it local-only
const HOST = process.env.PORT ? "0.0.0.0" : "127.0.0.1";

const serviceAccount = process.env.FIREBASE_KEY
  ? JSON.parse(process.env.FIREBASE_KEY)
  : JSON.parse(fs.readFileSync(path.join(__dirname, "serviceAccountKey.json"), "utf8"));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const loanRef = admin.firestore().collection("loans").doc(LOAN_ID);
const instRef = loanRef.collection("installments");
const histRef = loanRef.collection("history");
const docId = (p) => String(p).padStart(2, "0");

async function recompute() {
  const list = (await instRef.get()).docs.map((d) => d.data());
  const paidList = list.filter((i) => i.paid);
  const amountPaid = paidList.reduce((s, i) => s + (i.amount ?? 0), 0);
  const price = (await loanRef.get()).data().price;
  await loanRef.update({
    totalPeriods: list.length,
    paidPeriods: paidList.length,
    remainingPeriods: list.length - paidList.length,
    amountPaid,
    amountDue: price - amountPaid,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// ---- History: every add / edit / delete is saved with the values before and after ----
const FIELDS = ["amount", "dueDate", "paid"];
const pick = (o) => (o ? Object.fromEntries(FIELDS.filter((f) => o[f] !== undefined).map((f) => [f, o[f] ?? null])) : null);
async function logChange(action, period, before, after) {
  try {
    await histRef.add({ at: admin.firestore.FieldValue.serverTimestamp(), action, period: Number(period), before: pick(before), after: pick(after) });
  } catch (e) { console.error("History not saved:", e.message); } // never block the real change
}

const fail = (res, e, code = 500) => res.status(code).json({ error: e.message ?? e });
const clean = (b) => {
  const o = {};
  if (typeof b.paid === "boolean") o.paid = b.paid;
  if (b.amount !== undefined && b.amount !== "" && Number.isFinite(Number(b.amount)) && Number(b.amount) >= 0) o.amount = Number(b.amount);
  if (b.dueDate !== undefined) o.dueDate = b.dueDate || null;
  return o;
};

const app = express();
app.use(express.json());

// Every change (POST / PATCH / DELETE) must include the password
// Online: set EDIT_PASSWORD in the host's Environment Variables (the "1234" fallback is for local use only)
const PASSWORD = process.env.EDIT_PASSWORD ?? "1234";
app.use("/api", (req, res, next) =>
  req.method === "GET" || req.body?.password === PASSWORD ? next() : res.status(403).json({ error: "Incorrect password" }));
app.get("/", (_, res) => res.sendFile(path.join(__dirname, "index.html")));

// Read all
app.get("/api/loan", async (_, res) => {
  try {
    const [loan, snap] = await Promise.all([loanRef.get(), instRef.orderBy("period").get()]);
    res.json({ loan: loan.data(), installments: snap.docs.map((d) => d.data()) });
  } catch (e) { fail(res, e); }
});

// Change history (newest first, last 100)
app.get("/api/history", async (_, res) => {
  try {
    const snap = await histRef.orderBy("at", "desc").limit(100).get();
    res.json(snap.docs.map((d) => { const x = d.data(); return { ...x, at: x.at ? x.at.toDate().toISOString() : null }; }));
  } catch (e) { fail(res, e); }
});

// Add installment (Insert)
app.post("/api/installments", async (req, res) => {
  try {
    const period = Number(req.body.period);
    if (!Number.isInteger(period) || period < 1) return fail(res, "Installment number must be a whole number, 1 or higher", 400);
    const data = clean(req.body);
    if (data.amount === undefined) return fail(res, "Enter the amount as a number", 400);
    const doc = { period, paid: false, dueDate: null, ...data };
    await instRef.doc(docId(period)).create(doc);
    await recompute();
    await logChange("add", period, null, doc);
    res.json({ ok: true });
  } catch (e) {
    fail(res, e.code === 6 ? `Installment ${req.body.period} already exists` : e, e.code === 6 ? 409 : 500);
  }
});

// Edit installment (Update)
app.patch("/api/installments/:period", async (req, res) => {
  try {
    const data = clean(req.body);
    if (!Object.keys(data).length) return fail(res, "Nothing to update", 400);
    const ref = instRef.doc(docId(req.params.period));
    const snap = await ref.get();
    if (!snap.exists) return fail(res, `Installment ${req.params.period} not found`, 404);
    const before = snap.data(), after = { ...before, ...data };
    await ref.update(data);
    await recompute();
    if (FIELDS.some((f) => (before[f] ?? null) !== (after[f] ?? null))) await logChange("edit", req.params.period, before, after);
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// Delete installment (Delete)
app.delete("/api/installments/:period", async (req, res) => {
  try {
    const ref = instRef.doc(docId(req.params.period));
    const snap = await ref.get();
    await ref.delete();
    await recompute();
    if (snap.exists) await logChange("delete", req.params.period, snap.data(), null);
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

app.listen(PORT, HOST, () => console.log(`Server running on port ${PORT}`));
