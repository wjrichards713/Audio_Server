#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import "dotenv/config";
import archiver from "archiver";
import semver from "semver";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- config via env ----------
const BUCKET = process.env.S3_BUCKET || "audio-redenes";
const REGION = process.env.AWS_REGION || "us-west-2";
const APP_NAME = (process.env.APP_NAME || getPkgName()).replace(/[^A-Za-z0-9_\-\.]/g,"_");
const BUMP = process.argv[2] || process.env.BUMP || "patch"; // patch | minor | major | exact x.y.z

if (!BUCKET) {
  console.error("S3_BUCKET env var is required");
  process.exit(1);
}

// ---------- helpers ----------
function getPkg() {
  const p = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
  return p;
}
function getPkgName(){ return getPkg().name || "app"; }
function updateVersion() {
  const pkg = getPkg();
  const current = pkg.version || "0.0.0";
  const next = ["patch","minor","major"].includes(BUMP) ? semver.inc(current, BUMP) : semver.valid(BUMP);
  if (!next) {
    console.error(`Bad version/bump: ${BUMP}`);
    process.exit(1);
  }
  // Use npm version to keep package-lock.json in sync without git tagging
  const res = spawnSync("npm", ["version", next, "--no-git-tag-version"], { stdio: "inherit" });
  if (res.status !== 0) process.exit(res.status);
  return next;
}

async function zipRepo(outFile) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outFile);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => resolve());
    archive.on("error", reject);

    archive.pipe(output);

    // include everything except excluded globs
    archive.glob("**/*", {
      ignore: [
        "node_modules/**",
        ".git/**",
        ".github/**",
        "*.log",
        ".env",
        ".env.*",
        "tmp/**",
        "dist/**.map", // optional
        ".artifacts/**",
        path.basename(outFile)  
      ],
      dot: true
    });

    archive.finalize();
  });
}

async function putS3(key, body, contentType) {
 // Prefer explicit env-based credentials to avoid discovery issues
 const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN } = process.env;
 if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
   console.error(
     "Missing AWS credentials. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (and AWS_SESSION_TOKEN if temporary)."
   );
   process.exit(1);
 }
 const s3 = new S3Client({
   region: REGION,
   credentials: {
     accessKeyId: AWS_ACCESS_KEY_ID,
     secretAccessKey: AWS_SECRET_ACCESS_KEY,
     sessionToken: AWS_SESSION_TOKEN || undefined,
   },
 });
    
  const cmd = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
    Metadata: {
      app: APP_NAME,
      version: version,
    }
  });
  const out = await s3.send(cmd);
  return out; // contains VersionId if versioning is enabled
}

// ---------- run ----------
const version = updateVersion();
const artifactName = `${APP_NAME}-v${version}.zip`;

const buildDir = path.join(process.cwd(), ".artifacts");
if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir);

const zipPath = path.join(buildDir, artifactName);

(async () => {
  console.log(`Zipping → ${zipPath}`);
  await zipRepo(zipPath);
  const zipBuffer = fs.readFileSync(zipPath);

  // Key layout
  // 1) canonical (overwrite): apps/<app>/APP_NAME.zip  (S3 Versioning gives rollback)
  // 2) versioned path:       apps/<app>/versions/vX.Y.Z/APP_NAME-vX.Y.Z.zip
  // 3) latest alias:         apps/<app>/latest.zip
  // 4) latest.json metadata: apps/<app>/latest.json

  const base = `apps/${APP_NAME}`;
  const keyCanonical = `${base}/${APP_NAME}.zip`;
  const keyVersioned = `${base}/versions/v${version}/${artifactName}`;
  const keyLatest = `${base}/latest.zip`;
  const keyLatestJson = `${base}/latest.json`;

  console.log(`Uploading: s3://${BUCKET}/${keyVersioned}`);
  const v1 = await putS3(keyVersioned, zipBuffer, "application/zip");

  console.log(`Uploading canonical: s3://${BUCKET}/${keyCanonical}`);
  const v2 = await putS3(keyCanonical, zipBuffer, "application/zip");

  console.log(`Uploading latest alias: s3://${BUCKET}/${keyLatest}`);
  const v3 = await putS3(keyLatest, zipBuffer, "application/zip");

  const latestJson = JSON.stringify({
    app: APP_NAME,
    version,
    keys: {
      versioned: keyVersioned,
      canonical: keyCanonical,
      latest: keyLatest
    },
    uploadedAt: new Date().toISOString(),
    s3VersionIds: {
      versioned: v1.VersionId || null,
      canonical: v2.VersionId || null,
      latest: v3.VersionId || null
    }
  }, null, 2);

  console.log(`Uploading latest.json: s3://${BUCKET}/${keyLatestJson}`);
  await putS3(keyLatestJson, latestJson, "application/json");

  console.log("\n✅ Done.");
  console.log(`Version: ${version}`);
  console.log(`Artifacts:
  - s3://${BUCKET}/${keyVersioned}
  - s3://${BUCKET}/${keyCanonical}  (overwrites; rollback via S3 VersionId)
  - s3://${BUCKET}/${keyLatest}
  - s3://${BUCKET}/${keyLatestJson}`);
})();
