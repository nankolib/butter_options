// useOrderFlows — thin React wrappers over the pure series write-path builders
// (orderFlows.ts). Pass 2. usePegFill / usePostOrder / useFillOrder.
import { useCallback, useState } from "react";
import { BN } from "@coral-xyz/anchor";
import { useProgram } from "./useProgram";
import {
  pegFill, postSeriesOrder, fillSeriesOrder, fillWriterAsk, cancelOrder,
  type SeriesRef, type FillableOrder,
} from "../pages/trade/orderFlows";

const micro = (usd: number) => new BN(Math.round(usd * 1_000_000));

export function usePegFill() {
  const { program } = useProgram();
  const [submitting, setSubmitting] = useState(false);
  const submit = useCallback(
    async (ref: SeriesRef, quantity: number, maxPremiumUsd: number): Promise<string | null> => {
      if (!program?.provider.publicKey) return null;
      setSubmitting(true);
      try {
        return await pegFill(program, ref, quantity, micro(maxPremiumUsd));
      } finally {
        setSubmitting(false);
      }
    },
    [program],
  );
  return { submitting, submit };
}

export function usePostOrder() {
  const { program } = useProgram();
  const [submitting, setSubmitting] = useState(false);
  const submit = useCallback(
    async (
      ref: SeriesRef, kind: "bid" | "resaleAsk" | "writerAsk", priceUsd: number, quantity: number, nonce: number,
    ): Promise<string | null> => {
      if (!program?.provider.publicKey) return null;
      setSubmitting(true);
      try {
        return await postSeriesOrder(program, ref, kind, micro(priceUsd), quantity, new BN(nonce));
      } finally {
        setSubmitting(false);
      }
    },
    [program],
  );
  return { submitting, submit };
}

export function useFillOrder() {
  const { program } = useProgram();
  const [submitting, setSubmitting] = useState(false);
  const submit = useCallback(
    async (order: FillableOrder, quantity: number): Promise<string | null> => {
      if (!program?.provider.publicKey) return null;
      setSubmitting(true);
      try {
        return await fillSeriesOrder(program, order, quantity);
      } finally {
        setSubmitting(false);
      }
    },
    [program],
  );
  return { submitting, submit };
}

export function useFillWriterAsk() {
  const { program } = useProgram();
  const [submitting, setSubmitting] = useState(false);
  const submit = useCallback(
    async (order: FillableOrder, quantity: number): Promise<string | null> => {
      if (!program?.provider.publicKey) return null;
      setSubmitting(true);
      try {
        return await fillWriterAsk(program, order, quantity);
      } finally {
        setSubmitting(false);
      }
    },
    [program],
  );
  return { submitting, submit };
}

export function useCancelOrder() {
  const { program } = useProgram();
  const [submitting, setSubmitting] = useState(false);
  const submit = useCallback(
    async (order: FillableOrder): Promise<string | null> => {
      if (!program?.provider.publicKey) return null;
      setSubmitting(true);
      try {
        return await cancelOrder(program, order);
      } finally {
        setSubmitting(false);
      }
    },
    [program],
  );
  return { submitting, submit };
}
