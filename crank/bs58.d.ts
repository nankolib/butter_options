// bs58 (v4) ships no type declarations, which made `crank` fail `tsc --noEmit`
// on _exec_reclaim_6gfxuov.ts. Declared here so the crank project type-checks
// clean and can carry a pre-commit compile gate (see .git/hooks/pre-commit).
declare module "bs58";
