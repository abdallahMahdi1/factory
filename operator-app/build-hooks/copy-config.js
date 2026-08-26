// electron-builder hook: runs automatically after `npm run build` finishes.
// If a config.json exists in the project root (the one you fill in with
// your real backend URL + machine API key before building), copy it into
// dist/ so it sits right next to the built .exe — exactly where main.js
// looks for it at runtime (via PORTABLE_EXECUTABLE_DIR for a portable
// build). Without this, the portable .exe builds fine but has no config
// next to it, and shows "Setup needed" on first launch even though
// config.json was correctly filled in during the build step.
//
// Signature per electron-builder's actual Hooks API: this hook receives a
// single BuildResult argument — { outDir, artifactPaths, platformToTargets,
// configuration } — NOT a { packager, artifactPaths } object. (An earlier
// version of this hook assumed the wrong shape and crashed with
// "Cannot read properties of undefined (reading 'projectDir')".)
const fs = require("fs");
const path = require("path");

exports.default = async function (buildResult) {
  const projectDir = __dirname ? path.join(__dirname, "..") : process.cwd();
  const source = path.join(projectDir, "config.json");
  if (!fs.existsSync(source)) {
    console.log("[afterAllArtifactBuild] No config.json in project root — skipping (dist will need one added manually before sharing the .exe).");
    return;
  }
  const artifactPaths = (buildResult && buildResult.artifactPaths) || [];
  for (const artifactPath of artifactPaths) {
    if (artifactPath.toLowerCase().endsWith(".exe")) {
      const destDir = path.dirname(artifactPath);
      const dest = path.join(destDir, "config.json");
      fs.copyFileSync(source, dest);
      console.log(`[afterAllArtifactBuild] Copied config.json -> ${dest}`);
    }
  }
};
