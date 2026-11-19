// Installment manager web app (add / edit / delete)  ->  npm run web, then open http://localhost:3000
// Connects to Firestore with serviceAccountKey.json and only accepts connections from this computer
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import admin from "firebase-admin";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOAN_ID = "ford-everest-sport-2020";
const PORT = 3000;

admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(fs.readFileSync(path.join(__dirname, "serviceAccountKey.json"), "utf8"))
  ),
});
const loanRef = admin.firestore().collection("loans").doc(LOAN_ID);
const instRef = loanRef.collection("installments");
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

// Add installment (Insert)
app.post("/api/installments", async (req, res) => {
  try {
    const period = Number(req.body.period);
    if (!Number.isInteger(period) || period < 1) return fail(res, "Installment number must be a whole number, 1 or higher", 400);
    const data = clean(req.body);
    if (data.amount === undefined) return fail(res, "Enter the amount as a number", 400);
    await instRef.doc(docId(period)).create({ period, paid: false, dueDate: null, ...data });
    await recompute();
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
    await instRef.doc(docId(req.params.period)).update(data);
    await recompute();
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// Delete installment (Delete)
app.delete("/api/installments/:period", async (req, res) => {
  try {
    await instRef.doc(docId(req.params.period)).delete();
    await recompute();
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

app.listen(PORT, "127.0.0.1", () => console.log(`Open the site at http://localhost:${PORT}`));
