import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Keeps the Linux packages agreeing with each other and with the binary.
 *
 * Every failure here is silent everywhere else. A package's dependency list
 * is a string nothing compiles: a deb that forgets `bubblewrap` installs and
 * launches fine, and the native agent then cannot run a single command. A
 * second copy of the list, edited in one place and not the other, ships two
 * packages that disagree about what Atlas needs. A binary that links a
 * library under one distro family's soname starts on Ubuntu and not on
 * Fedora, and its rpm installs either way. None of it fails a build or a test
 * on the machine that made it; release-linux.yml's Verify step finds some of
 * it on a real distro, at release time. This suite finds it at commit time.
 *
 * What it pins:
 *  - one list of runtime dependencies (scripts/linux/runtime-deps.sh), read
 *    by every package builder, with no second copy anywhere;
 *  - that list naming the sandbox and WebKitGTK 4.1 for every family;
 *  - no dead deb/rpm config in tauri.linux.conf.json (Tauri builds neither,
 *    and the copy there drifted unnoticed while package-linux.sh shipped);
 *  - bzip2 compiled in on Linux, for the soname reason in its manifest;
 *  - the bundled bubblewrap pinned to one version and one checksum;
 *  - the packages staged under target/, where the packager and the release
 *    workflow name the same directory. Staging under dist/ shipped once: the
 *    frontend sync (scripts/build-frontend.mjs) deletes everything in dist/
 *    that Vite did not emit, and tauri-build watches all of dist/, so the
 *    next build wiped the packages and relinked the app. Nothing errors
 *    either way; the symptom is a missing deb or a slow rebuild.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");

/** A bash array's items, from `NAME=( … )` in runtime-deps.sh. */
function bashArray(src: string, name: string): string[] {
  const body = src.match(new RegExp(`^${name}=\\(\\n([\\s\\S]*?)^\\)`, "m"))?.[1];
  if (body === undefined) throw new Error(`runtime-deps.sh has no ${name}=( … )`);
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

const DEPS = read("scripts/linux/runtime-deps.sh");
const FAMILIES = {
  deb: bashArray(DEPS, "DEB_DEPENDS"),
  rpm: bashArray(DEPS, "RPM_REQUIRES"),
  arch: bashArray(DEPS, "ARCH_DEPENDS"),
};

describe("Linux runtime dependencies", () => {
  it("lists the same number of capabilities for every package family", () => {
    // One row per capability; a row added to one family only is a drift.
    expect(FAMILIES.deb.length).toBeGreaterThan(3);
    expect(FAMILIES.rpm.length).toBe(FAMILIES.deb.length);
    expect(FAMILIES.arch.length).toBe(FAMILIES.deb.length);
  });

  it.each(Object.entries(FAMILIES))(
    "%s names bubblewrap, which the agent execs and no library scan can find",
    (_family, deps) => {
      expect(deps).toContain("bubblewrap");
    },
  );

  it("names WebKitGTK 4.1 for every family, the ABI Tauri 2 links", () => {
    expect(FAMILIES.deb).toContain("libwebkit2gtk-4.1-0");
    expect(FAMILIES.rpm).toContain("webkit2gtk4.1");
    expect(FAMILIES.arch).toContain("webkit2gtk-4.1");
  });

  it("is read by every package builder, which keeps no copy of its own", () => {
    for (const script of ["scripts/package-linux.sh", "scripts/linux/aur-pkgbuild.sh"]) {
      const src = read(script);
      expect(src, script).toMatch(/runtime-deps\.sh/);
      for (const name of ["libwebkit2gtk-4.1-0", "webkit2gtk4.1", "libgtk-3-0"]) {
        expect(src.includes(name), `${script} hardcodes ${name}`).toBe(false);
      }
    }
  });

  it("is not restated in tauri.linux.conf.json, which builds no deb or rpm", () => {
    const conf = JSON.parse(read("src-tauri/tauri.linux.conf.json"));
    expect(conf.bundle.targets).toEqual(["appimage"]);
    expect(conf.bundle.linux?.deb).toBeUndefined();
    expect(conf.bundle.linux?.rpm).toBeUndefined();
  });
});

describe("the Linux binary's portability", () => {
  it("compiles bzip2 in on Linux, so no distro's libbz2 soname is linked", () => {
    const manifest = read("crates/atlas-agent-store/Cargo.toml");
    const linuxTable = manifest.split(
      /^\[target\.'cfg\(target_os = "linux"\)'\.dependencies\]$/m,
    )[1];
    expect(linuxTable, "atlas-agent-store has no Linux-only dependency table").toBeDefined();
    expect(linuxTable.split(/^\[/m)[0]).toMatch(/^bzip2 = \{[^}]*features = \["static"\]/m);
  });

  it("pins the bundled bubblewrap to one release and its checksum", () => {
    const src = read("scripts/linux/build-bwrap.sh");
    const version = src.match(/^BWRAP_VERSION="([0-9.]+)"$/m)?.[1];
    const sha = src.match(/^BWRAP_SHA256="([0-9a-f]+)"$/m)?.[1];
    expect(version).toBeDefined();
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    expect(src).toMatch(/sha256sum -c/);
  });
});

describe("where the Linux packages are staged", () => {
  const packager = read("scripts/package-linux.sh");
  const workflow = read(".github/workflows/release-linux.yml");
  const outputDir = packager.match(/^OUTPUT_DIR="\$\{ROOT_DIR\}\/(.+)"$/m)?.[1];

  it("is under target/, with the binary, and never under dist/", () => {
    expect(outputDir).toBeDefined();
    expect(outputDir!.startsWith("target/")).toBe(true);
    expect(outputDir!.startsWith("dist/")).toBe(false);
  });

  it("is the directory release-linux.yml collects from", () => {
    // The workflow copies out of it by path; a rename on one side only makes
    // Collect fail with `cp: cannot stat` after a full build.
    expect(workflow).toContain(`${outputDir}/`);
    expect(workflow).not.toContain("dist/release-linux");
  });
});
