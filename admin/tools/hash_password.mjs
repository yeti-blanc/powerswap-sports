// PowerSwap Admin - one-time local password hashing helper.
//
// Run this locally to produce the value you paste into
// `wrangler secret put ADMIN_PASSWORD_HASH` (see admin/README.md). Your
// real password is typed at a masked prompt here, in your own terminal -
// it never appears in shell history, never gets sent anywhere, and is
// never seen by anything other than this script.
//
// Uses the same Web Crypto `crypto.subtle` API the deployed Worker uses
// (Node 20+ exposes it as a global), so the hash format matches exactly -
// no risk of a Node-vs-Workers PBKDF2 implementation mismatch.
//
// Output format: pbkdf2$sha256$<iterations>$<salt_b64>$<hash_b64>
// Self-describing on purpose, so the Worker's verify function - and any
// future iteration-count bump - doesn't need a second hardcoded constant
// to stay in sync with.
//
// Usage:
//   node admin/tools/hash_password.mjs

import readline from "readline";

const ITERATIONS = 100_000;

function readPasswordMasked(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const onData = (char) => {
      char = char.toString();
      if (char === "\n" || char === "\r" || char === "") return;
      process.stdout.write("\x1b[2K\x1b[200D" + prompt + "*".repeat(rl.line.length));
    };
    process.stdin.on("data", onData);
    rl.question(prompt, (answer) => {
      process.stdin.removeListener("data", onData);
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

function toBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

async function hashPassword(password, salt) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return new Uint8Array(bits);
}

async function main() {
  const password = await readPasswordMasked("New admin password: ");
  const confirm = await readPasswordMasked("Confirm: ");
  if (password !== confirm) {
    console.error("\nPasswords did not match. Nothing generated.");
    process.exit(1);
  }
  if (password.length < 12) {
    console.error("\nRefusing a password shorter than 12 characters for an internet-facing admin login.");
    process.exit(1);
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await hashPassword(password, salt);
  const encoded = `pbkdf2$sha256$${ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;

  console.log("\nStore this with:\n");
  console.log(`  cd admin && npx wrangler secret put ADMIN_PASSWORD_HASH`);
  console.log(`  (paste the value below when prompted)\n`);
  console.log(encoded);
  console.log("\nThis value is a hash, not your password - safe to have in your terminal scrollback,");
  console.log("but there's no reason to leave it lying around either. Nothing was written to disk.");
}

main();
