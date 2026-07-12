import AsyncStorage from "@react-native-async-storage/async-storage";
import { utils } from "@coral-xyz/anchor";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Connection, Transaction } from "@solana/web3.js";
import {
  checkSubmittedTransactionStatus,
  createSubmittedTransaction,
  confirmSubmittedTransaction
} from "../solana/transactionStatus";
import { ensureDevnetConnection } from "../solana/cluster";
import type { SubmittedTransaction, TransactionStatusResult } from "../types";
import type { ToastTone, TxFlowState, TxIntent } from "./models";
import { sanitizeUserVisibleText } from "./displaySafety";

type SignTransaction = (transaction: Transaction) => Promise<Transaction>;

type ToastInput = {
  tone: ToastTone;
  title: string;
  message?: string;
  signature?: string;
};

type UseTransactionFlowParams = {
  connection: Connection;
  signTransaction: SignTransaction;
  onConfirmed: () => Promise<void> | void;
  showToast: (toast: ToastInput) => void;
};

const initialState: TxFlowState = {
  phase: "idle",
  intent: null,
  pending: null,
  submitted: null,
  signature: null,
  error: null
};

const TX_RECEIPT_STORAGE_KEY = "@opta/seeker/last-transaction";
const STORED_PHASES = new Set(["sending", "confirming", "confirmed", "failed", "unknown", "checking"]);

type StoredReceipt = {
  version: 1;
  phase: "sending" | "confirming" | "confirmed" | "failed" | "unknown" | "checking";
  kind: TxIntent["kind"];
  contractCount: number;
  title: string;
  rows: TxIntent["rows"];
  submitLabel: string;
  confirmedMessage: string;
  submitted: SubmittedTransaction;
  error: string | null;
};

function isStoredReceipt(value: unknown): value is StoredReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<StoredReceipt>;
  return receipt.version === 1
    && typeof receipt.phase === "string"
    && STORED_PHASES.has(receipt.phase)
    && !!receipt.submitted
    && typeof receipt.submitted.signature === "string"
    && receipt.submitted.signature.trim().length > 0
    && typeof receipt.submitted.blockhash === "string"
    && typeof receipt.submitted.lastValidBlockHeight === "number"
    && Number.isFinite(receipt.submitted.lastValidBlockHeight)
    && typeof receipt.submitted.submittedAt === "number"
    && Number.isFinite(receipt.submitted.submittedAt)
    && (receipt.kind === "buy" || receipt.kind === "write")
    && receipt.submitted.kind === receipt.kind
    && typeof receipt.contractCount === "number"
    && Number.isFinite(receipt.contractCount)
    && typeof receipt.title === "string"
    && typeof receipt.submitLabel === "string"
    && typeof receipt.confirmedMessage === "string"
    && Array.isArray(receipt.rows)
    && receipt.rows.every((row) => !!row
      && typeof row.label === "string"
      && typeof row.value === "string");
}

function restoredIntent(receipt: StoredReceipt): TxIntent {
  return {
    kind: receipt.kind,
    contractCount: receipt.contractCount,
    title: sanitizeUserVisibleText(receipt.title),
    rows: receipt.rows.map((row) => ({
      label: sanitizeUserVisibleText(row.label),
      value: sanitizeUserVisibleText(row.value)
    })),
    submitLabel: sanitizeUserVisibleText(receipt.submitLabel),
    confirmedMessage: sanitizeUserVisibleText(receipt.confirmedMessage),
    build: async () => {
      throw new Error("A restored transaction receipt cannot be re-sent.");
    }
  };
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return sanitizeUserVisibleText(error.message);
  return sanitizeUserVisibleText(String(error || "Transaction failed"));
}

function atomicFailureText(intent: TxIntent, message: string): string {
  if (intent.kind !== "write" || /nothing was deposited/i.test(message)) return message;
  return `${message} Nothing was deposited.`;
}

function resultError(result: TransactionStatusResult): string {
  return sanitizeUserVisibleText(result.error || "Transaction failed on-chain");
}

function receiptFor(
  phase: StoredReceipt["phase"],
  intent: TxIntent,
  submitted: SubmittedTransaction,
  error: string | null
): StoredReceipt {
  return {
    version: 1,
    phase,
    kind: intent.kind,
    contractCount: intent.contractCount,
    title: intent.title,
    rows: intent.rows,
    submitLabel: intent.submitLabel,
    confirmedMessage: intent.confirmedMessage,
    submitted,
    error
  };
}

export function useTransactionFlow({
  connection,
  signTransaction,
  onConfirmed,
  showToast
}: UseTransactionFlowParams) {
  const [state, setState] = useState<TxFlowState>(initialState);
  const stateRef = useRef(state);
  const runId = useRef(0);
  const restored = useRef(false);
  const hydrationAttempt = useRef(0);
  const persistQueue = useRef<Promise<void>>(Promise.resolve());
  const [hydrated, setHydrated] = useState(false);
  const [hydrationError, setHydrationError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const update = useCallback((next: TxFlowState | ((current: TxFlowState) => TxFlowState)) => {
    setState((current) => {
      const resolved = typeof next === "function" ? next(current) : next;
      stateRef.current = resolved;
      return resolved;
    });
  }, []);

  const openReview = useCallback((intent: TxIntent) => {
    if (!hydrated) return;
    const current = stateRef.current;
    if (current.submitted && ["sending", "confirming", "unknown", "checking"].includes(current.phase)) {
      // Keep the unresolved signature authoritative. Reopening the existing
      // receipt is the only safe action; a new write could duplicate collateral.
      setDismissed(false);
      return;
    }
    runId.current += 1;
    restored.current = false;
    setDismissed(false);
    update({
      phase: "review",
      intent,
      pending: null,
      submitted: null,
      signature: null,
      error: null
    });
  }, [hydrated, update]);

  const hydrateReceipt = useCallback(async () => {
    const attempt = ++hydrationAttempt.current;
    setHydrated(false);
    setHydrationError(null);
    try {
      const stored = await AsyncStorage.getItem(TX_RECEIPT_STORAGE_KEY);
      if (attempt !== hydrationAttempt.current) return;
      if (stored) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(stored);
        } catch {
          throw new Error("The saved transaction receipt is unreadable.");
        }
        if (!isStoredReceipt(parsed)) {
          throw new Error("The saved transaction receipt could not be verified.");
        }
        restored.current = true;
        setDismissed(false);
        const restoredPhase = parsed.phase === "sending"
          || parsed.phase === "confirming"
          || parsed.phase === "checking"
          ? "unknown"
          : parsed.phase;
        update({
          phase: restoredPhase,
          intent: restoredIntent(parsed),
          pending: null,
          submitted: parsed.submitted,
          signature: parsed.submitted.signature,
          error: parsed.error
        });
      }
      setHydrated(true);
    } catch {
      if (attempt !== hydrationAttempt.current) return;
      setHydrationError("Saved transaction status could not be verified. New transactions remain disabled.");
    }
  }, [update]);

  useEffect(() => {
    void hydrateReceipt();
    return () => {
      hydrationAttempt.current += 1;
    };
  }, [hydrateReceipt]);

  useEffect(() => {
    if (!state.submitted || !state.intent) return;
    if (!["sending", "confirming", "confirmed", "failed", "unknown", "checking"].includes(state.phase)) return;
    const receipt = receiptFor(
      state.phase as StoredReceipt["phase"],
      state.intent,
      state.submitted,
      state.error
    );
    persistQueue.current = persistQueue.current
      .catch(() => undefined)
      .then(() => AsyncStorage.setItem(TX_RECEIPT_STORAGE_KEY, JSON.stringify(receipt)))
      .catch(() => {
        // The in-memory receipt remains authoritative for this session.
      });
  }, [state]);

  const settleResult = useCallback(async (
    result: TransactionStatusResult,
    submitted: SubmittedTransaction,
    intent: TxIntent,
    currentRun: number
  ) => {
    if (currentRun !== runId.current) return;
    if (result.state === "confirmed") {
      update((current) => ({
        ...current,
        phase: "confirmed",
        submitted,
        signature: submitted.signature,
        error: null
      }));
      try {
        await onConfirmed();
      } catch {
        // Confirmation is authoritative; a follow-up read failure must never
        // downgrade a landed transaction to STATUS UNKNOWN.
      }
      showToast({
        tone: "success",
        title: "Transaction confirmed",
        message: intent.confirmedMessage,
        signature: submitted.signature
      });
      return;
    }
    if (result.state === "failed") {
      const message = resultError(result);
      update((current) => ({
        ...current,
        phase: "failed",
        submitted,
        signature: submitted.signature,
        error: message
      }));
      showToast({ tone: "error", title: "Transaction failed", message, signature: submitted.signature });
      return;
    }
    update((current) => ({
      ...current,
      phase: "unknown",
      submitted,
      signature: submitted.signature,
      error: null
    }));
    showToast({
      tone: "info",
      title: "Status unknown",
      message: intent.kind === "write" ? "Checking never re-deposits." : "Checking never re-sends the order.",
      signature: submitted.signature
    });
  }, [onConfirmed, showToast, update]);

  const submit = useCallback(async () => {
    const intent = stateRef.current.intent;
    if (!intent) return;
    const currentRun = ++runId.current;
    let signature: string | null = null;
    let submitted: SubmittedTransaction | null = null;
    update((current) => ({ ...current, phase: "simulating", error: null }));

    try {
      const pending = await intent.build();
      if (currentRun !== runId.current) return;
      if (pending.simulationError) {
        throw new Error(`Simulation failed: ${pending.simulationError}`);
      }

      await ensureDevnetConnection(connection);
      const latest = await connection.getLatestBlockhashAndContext("confirmed");
      if (currentRun !== runId.current) return;
      pending.transaction.recentBlockhash = latest.value.blockhash;
      pending.blockhash = latest.value.blockhash;
      pending.lastValidBlockHeight = latest.value.lastValidBlockHeight;
      update((current) => ({ ...current, phase: "awaitingWallet", pending }));

      const signed = await signTransaction(pending.transaction);
      if (currentRun !== runId.current) return;
      const feePayerSignature = signed.feePayer
        ? signed.signatures.find((entry) => entry.publicKey.equals(signed.feePayer!))?.signature
        : signed.signature;
      if (!feePayerSignature) throw new Error("The wallet did not sign the transaction.");
      signature = utils.bytes.bs58.encode(feePayerSignature);
      submitted = createSubmittedTransaction(pending, signature, intent.kind);
      update((current) => ({
        ...current,
        phase: "sending",
        submitted,
        signature,
        error: null
      }));

      // Durably write the signature before starting confirmation work. A crash
      // after this point can restore STATUS UNKNOWN and can never auto-resend.
      try {
        await AsyncStorage.setItem(
          TX_RECEIPT_STORAGE_KEY,
          JSON.stringify(receiptFor("sending", intent, submitted, null))
        );
      } catch {
        const message = intent.kind === "write"
          ? "Receipt storage is unavailable. Nothing was sent or deposited."
          : "Receipt storage is unavailable. Nothing was sent.";
        update((current) => ({
          ...current,
          phase: "failed",
          submitted: null,
          signature: null,
          error: message
        }));
        showToast({ tone: "error", title: "Transaction not sent", message });
        return;
      }
      if (currentRun !== runId.current) return;

      const rpcSignature = await connection.sendRawTransaction(signed.serialize(), {
        minContextSlot: latest.context.slot,
        preflightCommitment: "confirmed",
        maxRetries: 3
      });
      if (rpcSignature !== signature) {
        throw new Error("The RPC returned a different transaction signature.");
      }
      update((current) => ({ ...current, phase: "confirming" }));
      const result = await confirmSubmittedTransaction(connection, submitted);
      await settleResult(result, submitted, intent, currentRun);
    } catch (nextError) {
      if (currentRun !== runId.current) return;
      if (signature && submitted) {
        update((current) => ({
          ...current,
          phase: "unknown",
          submitted,
          signature,
          error: null
        }));
        showToast({
          tone: "info",
          title: "Status unknown",
          message: intent.kind === "write" ? "Checking never re-deposits." : "Checking never re-sends the order.",
          signature
        });
        return;
      }
      const message = atomicFailureText(intent, errorText(nextError));
      update((current) => ({ ...current, phase: "failed", error: message }));
      showToast({ tone: "error", title: "Transaction failed", message });
    }
  }, [connection, settleResult, showToast, signTransaction, update]);

  const checkStatus = useCallback(async () => {
    const current = stateRef.current;
    if (current.phase !== "unknown" || !current.submitted || !current.intent) return;
    const currentRun = ++runId.current;
    update((value) => ({ ...value, phase: "checking", error: null }));
    try {
      const result = await checkSubmittedTransactionStatus(connection, current.submitted);
      await settleResult(result, current.submitted, current.intent, currentRun);
    } catch {
      if (currentRun !== runId.current) return;
      update((value) => ({ ...value, phase: "unknown", error: null }));
    }
  }, [connection, settleResult, update]);

  const cancel = useCallback(() => {
    const phase = stateRef.current.phase;
    if (phase !== "review" && phase !== "simulating") return;
    runId.current += 1;
    update(initialState);
  }, [update]);

  const close = useCallback(() => {
    const phase = stateRef.current.phase;
    if (phase === "awaitingWallet" || phase === "sending" || phase === "confirming" || phase === "checking") return;
    if (phase === "unknown") {
      setDismissed(true);
      return;
    }
    runId.current += 1;
    update(initialState);
    void AsyncStorage.removeItem(TX_RECEIPT_STORAGE_KEY).catch(() => undefined);
  }, [update]);

  const retry = useCallback(() => {
    if (stateRef.current.phase !== "failed" || restored.current) return;
    void submit();
  }, [submit]);

  const reopenPending = useCallback(() => {
    const current = stateRef.current;
    if (current.submitted && ["sending", "confirming", "unknown", "checking"].includes(current.phase)) {
      setDismissed(false);
    }
  }, []);

  return {
    state,
    openReview,
    submit,
    cancel,
    close,
    retry,
    checkStatus,
    reopenPending,
    hydrated,
    hydrationError,
    retryHydration: hydrateReceipt,
    hasUnresolved: !!state.submitted && ["sending", "confirming", "unknown", "checking"].includes(state.phase),
    visible: state.phase !== "idle" && !dismissed,
    retryAvailable: state.phase === "failed" && !restored.current,
    cancelDisabled: !["review", "simulating"].includes(state.phase)
  };
}
