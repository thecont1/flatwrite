#!/usr/bin/env node
/**
 * Vendor the browser extraction assets into public/vendor/.
 *
 * The app has no bundler, so the WASM glue, WASM binaries, Tesseract worker,
 * Tesseract core variants, and English OCR model are copied verbatim from the
 * exact dependency versions in node_modules. The output directory is wiped and
 * regenerated on every run; extract-manifest.json is the runtime discovery
 * mechanism and records every relative path plus byte size.
 */
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const VENDOR_DIR = path.join(PUBLIC_DIR, 'vendor');

async function packageVersion(packageName) {
  const packageJsonPath = path.join(ROOT, 'node_modules', ...packageName.split('/'), 'package.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  return packageJson.version;
}

async function copyIn(source, target) {
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target);
  const info = await stat(target);
  return info.size;
}

function publicRelative(target) {
  return path.relative(PUBLIC_DIR, target).split(path.sep).join('/');
}

async function copyNamed(files, sourceDir, targetDir) {
  const copied = {};
  for (const file of files) {
    const sizeBytes = await copyIn(path.join(sourceDir, file), path.join(targetDir, file));
    copied[file] = { path: publicRelative(path.join(targetDir, file)), sizeBytes };
  }
  return copied;
}

async function main() {
  const anydocVersion = await packageVersion('@firecrawl/anydoc-wasm');
  const pdfVersion = await packageVersion('@firecrawl/pdf-inspector-wasm');
  const tesseractVersion = await packageVersion('tesseract.js');
  const tesseractCoreVersion = await packageVersion('tesseract.js-core');
  const engVersion = await packageVersion('@tesseract.js-data/eng');

  await rm(VENDOR_DIR, { recursive: true, force: true });
  await mkdir(VENDOR_DIR, { recursive: true });

  const anydocDir = path.join(VENDOR_DIR, `anydoc-${anydocVersion}`);
  const anydocFiles = await copyNamed(
    ['anydoc_wasm.js', 'anydoc_wasm_bg.wasm'],
    path.join(ROOT, 'node_modules', '@firecrawl', 'anydoc-wasm'),
    anydocDir,
  );

  const pdfDir = path.join(VENDOR_DIR, `pdf-inspector-${pdfVersion}`);
  const pdfFiles = await copyNamed(
    ['pdf_inspector_wasm.js', 'pdf_inspector_wasm_bg.wasm'],
    path.join(ROOT, 'node_modules', '@firecrawl', 'pdf-inspector-wasm'),
    pdfDir,
  );

  const tesseractDir = path.join(VENDOR_DIR, `tesseract-${tesseractVersion}`);
  const tesseractDist = path.join(ROOT, 'node_modules', 'tesseract.js', 'dist');
  const tesseractFiles = await copyNamed(
    ['worker.min.js', 'tesseract.min.js'],
    tesseractDist,
    tesseractDir,
  );

  // The browser loader's getCore picks exactly one single-file `.wasm.js`
  // build per SIMD support tier, and local-extract.js hardcodes
  // OEM.LSTM_ONLY, so only the three `-lstm.wasm.js` builds are ever
  // fetched. The standalone `.js`/`.wasm` pairs (~9 MB) are dead weight.
  const coreSourceDir = path.join(ROOT, 'node_modules', 'tesseract.js-core');
  const coreFileNames = (await readdir(coreSourceDir))
    .filter((file) => /^tesseract-core(-relaxedsimd|-simd)?-lstm\.wasm\.js$/.test(file))
    .sort();
  if (coreFileNames.length !== 3) {
    throw new Error(`expected 3 lstm .wasm.js core builds, found: ${coreFileNames.join(', ')}`);
  }
  const coreFiles = await copyNamed(coreFileNames, coreSourceDir, tesseractDir);

  // createWorker('eng', OEM.LSTM_ONLY) uses the smaller LSTM-only traineddata
  // variant upstream. It is copied to the stable filename tesseract.js asks for:
  // <langPath>/eng.traineddata.gz.
  const engSource = path.join(
    ROOT,
    'node_modules',
    '@tesseract.js-data',
    'eng',
    '4.0.0_best_int',
    'eng.traineddata.gz',
  );
  const engTarget = path.join(tesseractDir, 'eng.traineddata.gz');
  const engSize = await copyIn(engSource, engTarget);
  const files = {
    ...anydocFiles,
    ...pdfFiles,
    ...tesseractFiles,
    ...coreFiles,
    'eng.traineddata.gz': { path: publicRelative(engTarget), sizeBytes: engSize },
  };

  const manifest = {
    versions: {
      anydoc: anydocVersion,
      pdfInspector: pdfVersion,
      tesseract: tesseractVersion,
      tesseractCore: tesseractCoreVersion,
      eng: engVersion,
    },
    anydoc: {
      dir: publicRelative(anydocDir),
      script: anydocFiles['anydoc_wasm.js'].path,
      wasm: anydocFiles['anydoc_wasm_bg.wasm'].path,
    },
    pdfInspector: {
      dir: publicRelative(pdfDir),
      script: pdfFiles['pdf_inspector_wasm.js'].path,
      wasm: pdfFiles['pdf_inspector_wasm_bg.wasm'].path,
    },
    tesseract: {
      dir: publicRelative(tesseractDir),
      script: tesseractFiles['tesseract.min.js'].path,
      worker: tesseractFiles['worker.min.js'].path,
      corePath: publicRelative(tesseractDir),
      langPath: publicRelative(tesseractDir),
      traineddata: `vendor/tesseract-${tesseractVersion}/eng.traineddata.gz`,
      coreFiles: Object.fromEntries(Object.entries(coreFiles).map(([file, value]) => [file, value.path])),
    },
    files,
  };

  await writeFile(
    path.join(VENDOR_DIR, 'extract-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  const totalBytes = Object.values(files).reduce((sum, file) => sum + file.sizeBytes, 0);
  console.log(`vendored ${Object.keys(files).length} extraction assets (${totalBytes} bytes) into ${publicRelative(VENDOR_DIR)}/`);
  for (const [file, value] of Object.entries(files)) {
    console.log(`${value.path}\t${value.sizeBytes}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
