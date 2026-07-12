import { useCallback, useEffect, useRef, useState } from "react";
import type { Connection } from "@solana/web3.js";
import { loadEpochTenorCandidates } from "../solana/epoch";
import type { DataPhase, EpochTenor } from "./models";
import { sanitizeUserVisibleText } from "./displaySafety";

export type EpochCandidateView = {
  tenor: EpochTenor;
  expiry: number;
};

function errorText(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return sanitizeUserVisibleText(error.message);
  return sanitizeUserVisibleText(String(error || "Could not load expiry schedule"));
}

export function useEpochTenors(connection: Connection) {
  const [candidates, setCandidates] = useState<EpochCandidateView[]>([]);
  const [phase, setPhase] = useState<DataPhase>("loading");
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const currentRequest = ++requestId.current;
    setPhase("loading");
    setError(null);
    try {
      const result = await loadEpochTenorCandidates(connection);
      if (currentRequest !== requestId.current) return;
      const next = result.candidates.map((candidate) => ({
        tenor: candidate.tenor as EpochTenor,
        expiry: candidate.expiry
      }));
      setCandidates(next);
      setPhase(next.length > 0 ? "loaded" : "empty");
    } catch (nextError) {
      if (currentRequest !== requestId.current) return;
      setCandidates([]);
      setError(errorText(nextError));
      setPhase("error");
    }
  }, [connection]);

  useEffect(() => {
    void load();
    return () => {
      requestId.current += 1;
    };
  }, [load]);

  return { candidates, phase, error, reload: load };
}
