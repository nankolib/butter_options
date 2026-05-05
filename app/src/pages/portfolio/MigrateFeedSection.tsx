import type { FC } from "react";
import { PublicKey } from "@solana/web3.js";
import { useProgram } from "../../hooks/useProgram";
import { useIsAdmin } from "../../hooks/useIsAdmin";
import { MetaLabel } from "../../components/layout";
import { MigrateFeedTools } from "../../components/portfolio/MigrateFeedTools";

interface AccountRecord {
  publicKey: PublicKey;
  account: any;
}

type MigrateFeedSectionProps = {
  markets: AccountRecord[];
  onRefetch: () => void;
};

/**
 * MigrateFeedSection — admin-only Pyth feed_id rotation.
 *
 * Renders only when the connected wallet matches `protocolState.admin`.
 * Non-admins see nothing — no fallback messaging, no empty section
 * header (per locked Stage P4e decision).
 *
 * The feed_id rotation calls `migrate_pyth_feed` (Stage P3 instruction)
 * which is admin-gated on-chain via `require_keys_eq!(admin.key(),
 * protocol_state.admin, OptaError::Unauthorized)`. The UI gate is
 * cosmetic — it just hides the section from non-admins so they aren't
 * shown a button they'd be rejected for using.
 */
export const MigrateFeedSection: FC<MigrateFeedSectionProps> = ({
  markets,
  onRefetch,
}) => {
  const { program } = useProgram();
  const isAdmin = useIsAdmin();

  if (!isAdmin || !program) return null;

  return (
    <section className="mt-16">
      <MetaLabel as="div" className="mb-6">
        Admin · Pyth feed migration
      </MetaLabel>
      <MigrateFeedTools
        markets={markets}
        program={program}
        onRefetch={onRefetch}
      />
    </section>
  );
};

export default MigrateFeedSection;
