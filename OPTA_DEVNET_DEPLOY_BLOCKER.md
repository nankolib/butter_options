# Opta — Devnet Deploy Blocker: Technical Handoff

**Status:** ✅ RESOLVED 2026-06-18 — see the "RESOLVED" section immediately below. (Originally: BLOCKED on producing a devnet-deployable program binary.)
**Nature:** Build-toolchain ↔ cluster epoch mismatch (not a bug in the program; not dep-specific; not RPC-specific).
**Date of diagnosis:** 2026-06-17
**Audience:** A Solana engineer with current program-deployment / platform-tools experience.

---

## 2026-06-18 — RESOLVED

Deployed successfully on 2026-06-18. The program upgraded in place (slot `470150095` → `470304536`, upgrade sig `3TQpK7r8…`); American options are enabled (`AMERICAN_ENABLED = true`, feature-free).

**Corrected root cause.** This doc attributed the `Detected sbpf_version required by the executable which are not enabled` rejection to a cluster-side transitional gap. That was only half right. The decisive factor was the **deploy-side CLI**: `solana program deploy` was still **solana-cli 2.2.14**, whose *local* ELF verifier does not enable SBPFv3 and **rejects a v3 binary before any transaction is sent** (pre-flight — so no buffer is ever stranded). The §6 matrix's "v3 rejected" rows were this local verifier, not the cluster.

**The fix (working recipe, all in WSL):**
1. `cargo install cargo-build-sbf --version 4.1.0` — the standalone Anza builder. Lands in `~/.cargo/bin`; invoke by **explicit path**, since the active solana install's `cargo-build-sbf` stays 2.2.14 and is earlier on `PATH`.
2. `~/.cargo/bin/cargo-build-sbf --install-only --tools-version v1.54 --force-tools-install`
3. `~/.cargo/bin/cargo-build-sbf --manifest-path programs/opta/Cargo.toml --arch v3 --tools-version v1.54` → `target/deploy/opta.so` with ELF **Flags 0x3** (feature-free; verify via `~/.cache/solana/v1.54/platform-tools/llvm/bin/llvm-readelf -h`).
4. **`agave-install init 4.1.0-rc.1`** — switch the active `solana` (deploy) CLI to a v3-capable verifier. NOTE: `4.1.0` is **not** a published release tag; only betas/rcs exist (`4.1.0-beta.1/2/3`, `4.1.0-rc.0/1`).
5. `solana program deploy target/deploy/opta.so --program-id CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq --upgrade-authority ~/.config/solana/id.json --url "$(cat ~/.opta-rpc-helius)" --use-rpc`

Both the **build tool** (`cargo-build-sbf`) and the **deploy CLI** (`solana`/`agave`) had to move to 4.1.x — upgrading only the builder reproduces the exact rejection. The cluster's now-active SBPFv3 gate (see the update below) was a necessary precondition, but the missing local step was the 4.1.0 deploy CLI.

---

## 2026-06-18 update -- current best path

Read-only devnet checks on 2026-06-18 show that the feature-gate half of this blocker has moved forward:

| Feature | Address | Active slot | State |
|---|---|---:|---|
| Enable SBPFv3 deployment/execution | `5cC3foj77CWun58pC51ebHFUWavHWKarWyR5UUik7dnC` | `461808000` | active |
| Disable v0/v1/v2 deployment | `B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g` | `470016000` | active |
| Current devnet slot checked | n/a | `470265374` | past both gates |

Implication: the earlier "wait for SBPFv3 gate activation" branch is no longer the blocker. Devnet now expects SBPFv3+ deployable binaries and rejects v0/v1/v2 deployments by design.

The next deploy attempt should use the standalone Anza builder:

```bash
cargo install cargo-build-sbf --version 4.1.0
cargo build-sbf --install-only --tools-version v1.54 --force-tools-install

# from the Opta repo, with feature_flags.rs already flipped:
cargo build-sbf --manifest-path programs/opta/Cargo.toml --arch v3 --tools-version v1.54

# sanity-check the ELF header; expect Flags: 0x3
~/.cache/solana/v1.54/platform-tools/llvm/bin/llvm-readelf -h target/deploy/opta.so | grep Flags
```

Then deploy with `solana program deploy` against the canonical program id, not `anchor deploy`:

```bash
solana program deploy target/deploy/opta.so \
  --program-id CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq \
  --upgrade-authority /path/to/5YRMuuoY-upgrade-authority.json \
  --url "$(cat ~/.opta-rpc-helius)" \
  --use-rpc
```

Live checks also show the revised American flip warmup trigger is satisfied for crypto majors:

| Asset | VolOracle samples | Freshness |
|---|---:|---|
| BTC | `206` | ~58 min since push |
| ETH | `204` | ~58 min since push |
| SOL | `207` | ~58 min since push |

Metals/equities remain self-gated by their own `VolOracleWarmup` state, which is expected and does not block the crypto American flip.

### 2026-06-18 Codex environment note

This Windows Codex shell can see the repo but not the original Claude Code WSL environment:

- `wsl.exe --list --verbose` reports no installed distributions in this shell.
- Existing repo artifact `target/sbf-solana-solana/release/opta.so` was produced by the earlier Linux/Solana setup (`/home/nanko/.cache/solana/v1.52/...`) but has ELF `Flags: 0x0`, so it is the old rejected binary format.
- A direct Windows v3 build with Anza platform-tools v1.54 reaches host build-script linking, then stops because this machine lacks MSVC/Windows SDK import libraries (`kernel32.lib`, `ntdll.lib`, `ws2_32.lib`, etc.).

So the next successful path is to run the command block above from the already-working Claude Code/Linux environment that owns `/home/nanko`, or to install a real Windows host build toolchain before trying to build from this Codex shell.

## TL;DR

We need to ship a **one-line config flip** to an existing Solana **devnet** program (an in-place upgrade). The flip is written, correct, and fully tested. The *only* thing failing is the deploy: **every fresh build is rejected by devnet's loader** with:

```
Detected sbpf_version required by the executable which are not enabled
```

**Root cause:** devnet is running **Agave 4.1.0-beta.2**, while our build toolchain is **solana CLI 2.2.14 / platform-tools v1.52 (rustc 1.89.0-dev)**. The 4.x loader **rejects 2.2.14-emitted binaries at every SBPF version (v0–v4)**, and the new **SBPFv3 deployment gate (SIMD-0161) is still INACTIVE on devnet** — a transitional gap where the old binary format is no longer accepted and the new deployment path is not yet switched on.

**Proof it's cluster-side, not us:** a bare **904-byte no-op program** (no Anchor, no dependencies) is rejected identically, at every SBPF version, on **both Helius and public devnet RPC**. So it is categorically *not* dependency-specific, program-specific, or RPC-specific.

The **live program still executes normally** because it was deployed weeks ago under the *old* devnet runtime. No fresh build of any kind will deploy now.

**The core question for the solver:** *What toolchain / CLI / platform-tools version produces a binary that Agave 4.1.0-beta.2 devnet accepts for a NEW deployment today — and/or is this a known temporary network-wide devnet deploy freeze pending a feature-gate activation?*

---

## 1. Context: what Opta is, and what we're trying to do

- **Opta** is a permissionless options protocol on Solana (Anchor 0.32.1), deployed on **devnet**. The major build phase is complete.
- The **only remaining step** is enabling American options: flipping one compile-time constant `AMERICAN_ENABLED` from `false` → `true` in `programs/opta/src/feature_flags.rs`, then redeploying the program in place.
- This is a **one-const source change**, deployed **feature-free** (a compile-time guard, "LOW-5", requires production builds to carry no Cargo features).
- The flip is **verified correct**: full in-process test suite (`solana-bankrun`) passes **80/0** on the flipped binary, including the American-path canary (American vault creation no longer reverts the disabled-gate error) and European byte-identical regression checks.

**There is nothing wrong with the program or the flip.** The entire problem is producing a binary the cluster will accept.

---

## 2. Key identifiers

| Item | Value |
|---|---|
| Program ID (main) | `CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq` |
| Transfer-hook program | `83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG` |
| Upgrade authority (pubkey) | `5YRMuuoY3P7z5GeRAAQND7BxgNdmPSa6CSPCJLca1zZk` |
| Current live program slot | `470150095` (last-deployed slot; runs fine, `AMERICAN_ENABLED = false`) |
| Cluster | Solana **devnet** |
| Deployer / authority balance | ~16.26 SOL (ample) |
| Framework | **Anchor 0.32.1** |
| Solana SDK in tree | **solana-program 2.3.0** |

**Deploy command that MUST be used** (not `anchor deploy`):

```bash
solana program deploy <opta.so> \
  --program-id CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq \
  --upgrade-authority <5YRMuuoY keypair>
```

> `anchor deploy` must NOT be used: a `cargo clean` earlier regenerated `target/deploy/opta-keypair.json` to a wrong address (`Fw9fbLyG…`), so `anchor deploy` would attempt to create a *new* program rather than upgrade the canonical one. The upgrade is authorized by the `5YRMuuoY` upgrade authority against the program address, so the regenerated keypair is irrelevant for `solana program deploy`.

---

## 3. The blocker (exact behavior)

Every fresh-from-source build — regardless of toolchain, SBPF version tag, target triple, or RPC — is rejected at deploy time with:

```
Detected sbpf_version required by the executable which are not enabled
```

The pre-upgrade phase (`createAccount` + `initializeBuffer` + `extendProgram`) can land; the **final upgrade transaction fails**. SOL is recoverable (close the stranded buffer). The on-chain program is never modified by a failed attempt.

---

## 4. Root cause

- **devnet is running Agave 4.1.0-beta.2.** Our local toolchain is **solana CLI 2.2.14 / platform-tools v1.52 / rustc 1.89.0-dev**.
- Agave 4.x **reworked program deployment** via three SIMDs, bundled as the SBPFv3 deployment path:
  - **SIMD-0178** — static syscalls (resolve syscalls at link time, removing ELF relocations)
  - **SIMD-0189** — stricter ELF layout requirements for programs
  - **SIMD-0377** — ISA compatibility
- The expectation is that a **4.x-compliant linker toolchain emits compliant binaries automatically** (i.e. newer platform-tools than 2.2.14 ships).
- **Critically:** on devnet the SBPF-versioning gate **SIMD-0161 (`C8XZNs1b…`) is still INACTIVE.**

This puts devnet 4.1-beta in a **transitional gap**:
1. The 4.x loader **no longer accepts our 2.2.14-emitted binaries** (any SBPF version v0–v4) — most likely the SIMD-0189 stricter-ELF check failing across the board, surfaced as the "sbpf_version … not enabled" error.
2. The **new SBPFv3 deployment path that 4.x wants is not yet activated.**

This is why the **live binary still executes** (it was deployed under the *prior* devnet runtime) but **no fresh build of any version deploys now**.

---

## 5. Why our toolchain is where it is (the dependency vise)

This explains why we can't just "use an older toolchain":

- `solana-program 2.3.0` pulls a transitive **edition2024** crate chain:
  `solana-program 2.3.0` → `solana-blake3-hasher 2.2.1` → `blake3 1.8.4` → `digest 0.11.2` → **`block-buffer 0.12.0` (edition = 2024)**.
  `solana-program 2.3.0` is required by `anchor-spl 0.32.1`, `pyth-solana-receiver-sdk`, `mpl-token-metadata 5.1.1`, and `spl-associated-token-account 7.0.0`.
- **edition2024 requires rustc ≥ 1.85.** Among the platform-tools we have on disk, **only v1.52 (rustc 1.89) can compile it**; v1.47/v1.48/v1.51 ship **rustc 1.84.1** and fail with `feature edition2024 is required … not stabilized in this version of Cargo (1.84.0)`.
- A **manual `~/.cache/solana/v1.47/platform-tools → v1.52` symlink** was put in place (real v1.47 backed up to `platform-tools.old`) specifically to get rustc 1.89 for these deps.
- For months, deploys succeeded only because builds **reused an older object cache** (heavy deps compiled by an older, accepted-format toolchain and relinked). A **`cargo clean`** — required to fix an unrelated stale-binary bug — destroyed that cache, forcing a full from-scratch recompile under v1.52 and exposing the underlying mismatch.

**`Cargo.lock` is gitignored** (so there is no committed lock to restore); `block-buffer 0.12.0` has been in the resolved tree since ~2026-05-17.

---

## 6. Everything we tried — full elimination matrix

All builds are of the **flipped, feature-free** program unless noted. Each was a genuine from-scratch build (`cargo clean` first). "devnet" = Agave 4.1.0-beta.2.

| Build config | Toolchain / target | e_flags | devnet result |
|---|---|---|---|
| Incremental (old object cache) — *the currently-live binary* | ancient cached objects | 0x0 | ✅ deployed (pre-4.x runtime) |
| `cargo build-sbf` default | v1.52 (rustc 1.89) | 0x0 | ❌ rejected |
| `cargo build-sbf --arch v0` | v1.52 | 0x0 | ❌ rejected |
| `cargo build-sbf` default (deps pinned to compile on 1.84.1) | v1.48 (rustc 1.84.1) | 0x0 | ❌ rejected |
| `cargo build-sbf --arch v2` | v1.52 | 0x2 | ❌ rejected |
| legacy `cargo +solana build --triple sbf-solana-solana --release` | v1.52 | 0x0 | ❌ rejected |
| **Minimal 904-byte no-op program**, `--target sbpfv0` + `-Z build-std` | v1.52 | 0x0 | ❌ rejected (also on public devnet RPC) |
| Minimal no-op, `--target sbpfv1` + build-std | v1.52 | 0x1 | ❌ rejected |
| Minimal no-op, `--target sbpfv2` + build-std | v1.52 | 0x2 | ❌ rejected |
| Minimal no-op, `--target sbpfv3` + build-std | v1.52 | 0x3 | ❌ rejected ("not enabled") |
| Minimal no-op, `--target sbpfv4` + build-std | v1.52 | 0x4 | ❌ rejected ("not enabled") |
| Minimal no-op, `RUSTFLAGS=-static-syscalls` + build-std | v1.52 | 0x0 | ❌ rejected |
| Minimal no-op, `cargo build-sbf` default | v1.48 (rustc 1.84.1) | 0x0 | ❌ rejected |

**Conclusion:** every SBPF version v0–v4 that any *locally available* toolchain can emit is rejected — even a bare no-op with zero dependencies, even on public devnet. The rejection is **categorically cluster-side**.

### Dependency-pinning workaround (compiled, but did NOT unblock deploy)
Pinning `blake3 1.8.4 → 1.5.5`, `proc-macro-crate 3.5.0 → 3.3.0`, `unicode-segmentation 1.13.2 → 1.12.0` removed the edition2024 + MSRV-≥1.85 blockers and let the tree **compile on v1.48 (rustc 1.84.1)**. That pinned build **passed the full bankrun suite 80/0** (pins are behaviorally inert — BLAKE3 is a fixed spec; the other two are build-time only). But the resulting binary was **still rejected by devnet**, confirming the blocker is the cluster, not compilation. The original/audited `Cargo.lock` has since been restored.

---

## 7. Codegen levers investigated (for completeness — none unblock it)

- `cargo-build-sbf --arch v0|v1|v2|v3` — sets the version *tag* (e_flags); capped at v3. Does not change instruction selection.
- Per-version rust targets `sbpfv0…v4-solana-solana` — require `-Z build-std=core` (no precompiled std). These *do* set e_flags 0x0–0x4 (the real way to force a clean version tag).
- `RUSTFLAGS -C target-feature=±{static-syscalls (V3/SIMD-0178), dynamic-frames (V1), abi-v2, alu32, crt-static}` — rustc-level SBF features; **ineffective without `-Z build-std`** (precompiled std otherwise gets linked in).
- LLVM-only codegen features (not rustc-settable): `pqr-instr, store-imm, explicit-sext, no-lddw, mem-encoding, callx-reg-src, reloc-abs64, jmp-ext` — these internally distinguish the versions.

None matter here: the issue is **not** which version we tag, it's that the **4.1-beta cluster accepts none of them from our 2.2.14 toolchain**.

---

## 8. Candidate solution paths (open questions for the solver)

1. **Install a 4.x-matching `agave`/`solana` CLI + platform-tools and rebuild.** This is the most obvious *untested* path — we exhaustively tested 2.2.14-era toolchains but never installed a 4.x toolchain that would emit SIMD-0189-compliant ELF. **Open question:** does a 4.x toolchain produce a binary devnet 4.1-beta accepts *given the SBPFv3 gate is inactive*? (A 4.x toolchain emitting v3 would still hit the inactive gate; can it emit a lower, *enabled* version with compliant ELF?)
2. **Wait for devnet to activate the SBPFv3 gate (SIMD-0161).** Given the gate is inactive *and* old-format binaries are rejected, this may be the only path that works — newer tools alone (emitting v3) would still hit the inactive gate.
3. **Confirm whether this is a known, network-wide transitional deploy freeze on devnet.** If new-program deployment to devnet is broadly broken during the 4.x transition, that settles it: the answer is "wait for the gate / matching toolchain," and there was no build-side fix available at the time. *(The minimal no-op being rejected strongly suggests this.)*

**The single highest-value question:** *Right now, what exact CLI/platform-tools version + build invocation produces a binary that Agave 4.1.0-beta.2 devnet accepts for a fresh deployment — or is devnet currently not accepting new deployments at all pending a feature-gate activation?*

---

## 9. What is verified & safe (current state)

- **Live program intact and executing** at slot `470150095`, `AMERICAN_ENABLED = false` — identical behavior to before this work. **Not bricked; no behavior change.**
- The flip is **source-correct** (`feature_flags.rs: AMERICAN_ENABLED = true`, uncommitted in the working tree) and **test-verified** (bankrun 80/0 on the flipped binary).
- **All SOL recovered** (~16.26 SOL on the deployer); all stranded deploy buffers closed.
- **Nothing committed; no toolchain/symlink change persisted.** One benign side-effect of a failed attempt: ProgramData is allocated ~4.4 KB larger (zero-padding from a `extendProgram` that landed before the upgrade tx failed) — cosmetic; the loader reads only the real code length.
- A failed attempt **cannot** modify the on-chain bytecode (the upgrade tx itself fails atomically).

---

## 10. Environment quick-reference

- OS: Windows 10 + WSL2; Solana tooling runs in WSL.
- Keypair: `/home/<user>/.config/solana/id.json`.
- RPC: Helius devnet (paid) + public devnet — both reject identically.
- Toolchain: solana CLI 2.2.14; platform-tools v1.52 via manual `v1.47 → v1.52` symlink; rustc 1.89.0-dev. Older platform-tools on disk: `v1.47/platform-tools.old`, `v1.48` (both rustc 1.84.1).
- Build guard: production builds must be **feature-free** (a `compile_error!` guard blocks any test/`american-enabled` feature without a `testing` marker). The flip is the `feature_flags.rs` default edit, deployed feature-free — **never** `--features american-enabled`.

---

## 11. References

- Agave v4.0 release notes (SBPFv3 deployment: SIMD-0178 / 0189 / 0377) — Helius / Anza
- Agave v4.0 & v4.1 release schedules — anza-xyz/agave wiki
- Feature Gate Tracker (SIMD-0161 SBPF versioning; gate status per cluster) — anza-xyz/agave wiki
- Solana docs — Programs / deployment
- `cargo-build-sbf` target-triple + SBPF versioning notes — agave CHANGELOG

---

*Prepared as a self-contained handoff. The program and flip are done; the sole open item is producing a binary that the current devnet runtime accepts (or confirming the activation timeline that unblocks it).*
