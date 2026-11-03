# Linux support

What Atlas supports on Linux, what each package needs, and how a Linux release is
built, checked, signed and announced.

- **Source of truth:** `.github/workflows/release-linux.yml` and the scripts it calls
  (`scripts/package-linux.sh`, `scripts/verify-linux-release.sh`, `scripts/linux/`).
- **Why it is shaped this way:** [`docs/research/linux-release-plan.md`](../research/linux-release-plan.md).

## Signing

Every release carries two kinds of integrity evidence.

- **Build provenance**, always. The publish job attests every artifact with
  `actions/attest-build-provenance`, tying it to the workflow run that built it. Anyone
  can check a download with:

  ```bash
  gh attestation verify tryatlas_0.4.2_amd64.deb --repo pacifio/atlas
  ```

- **GPG signatures**, once the release key exists. `scripts/linux/sign-release.sh` signs
  each rpm in place and writes `SHA256SUMS.txt.asc`, a detached signature over the
  checksum file, which covers every other artifact. The public key ships beside them as
  `atlas-release-signing-key.asc`. Until the key exists, the publish job skips both and
  leaves a warning titled "Linux release unsigned" on the run.

To check a download against the signed checksums:

```bash
gpg --import atlas-release-signing-key.asc
gpg --verify SHA256SUMS.txt.asc SHA256SUMS.txt
sha256sum --ignore-missing -c SHA256SUMS.txt
```

A key published beside the files it signs proves only that they were not changed after
signing. Its fingerprint should also be published somewhere the release does not
control, such as the website, so users can tell it is the real one.

### Creating the release key

A maintainer does this once. Who holds the key and how it is rotated is a decision for
the maintainers, not something the workflow decides.

```bash
# RSA 4096 rather than ed25519: older rpm builds (RHEL 8 era) cannot verify EdDSA.
gpg --quick-gen-key 'Atlas Release Signing <contact@tryatlas.cc>' rsa4096 sign 2y
gpg --armor --export-secret-keys <fingerprint> > atlas-release.key   # keep offline
```

Then add two repository secrets:

| secret                         | value                                            |
| ------------------------------ | ------------------------------------------------ |
| `LINUX_RELEASE_GPG_KEY`        | the armored private key (`atlas-release.key`)    |
| `LINUX_RELEASE_GPG_PASSPHRASE` | its passphrase, or leave unset for no passphrase |

The next release is signed. Delete the local `atlas-release.key` once it is stored
wherever the maintainers keep offline secrets.
