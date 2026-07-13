import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const mobileRoot = resolve(scriptDir, "..");
const androidDir = resolve(scriptDir, "..", "android");
const isWindows = process.platform === "win32";
const wrapper = isWindows ? "gradlew.bat" : "./gradlew";
const sdkCandidates = [
  process.env.ANDROID_HOME,
  process.env.ANDROID_SDK_ROOT,
  isWindows && process.env.LOCALAPPDATA ? resolve(process.env.LOCALAPPDATA, "Android", "Sdk") : null,
].filter(Boolean);
const androidSdk = sdkCandidates.find((candidate) => existsSync(candidate));

if (!existsSync(resolve(androidDir, isWindows ? "gradlew.bat" : "gradlew"))) {
  console.error("Android Gradle wrapper is missing. Restore the checked-in android directory.");
  process.exit(1);
}
if (!androidSdk) {
  console.error("Android SDK not found. Set ANDROID_HOME to an installed SDK.");
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, [resolve(scriptDir, "verify-seeker-build.mjs")], { cwd: mobileRoot });
run(process.execPath, [resolve(mobileRoot, "node_modules", "typescript", "bin", "tsc"), "--noEmit"], {
  cwd: mobileRoot,
});
run(wrapper, ["assembleReview"], {
  cwd: androidDir,
  shell: isWindows,
  env: {
    ...process.env,
    ANDROID_HOME: androidSdk,
    ANDROID_SDK_ROOT: androidSdk,
    NODE_ENV: "production",
  },
});
