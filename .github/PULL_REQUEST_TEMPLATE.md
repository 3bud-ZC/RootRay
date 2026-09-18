## What changed

<!-- One paragraph: what this PR does and why. -->

## Verification

<!-- How you verified it. Check what applies: -->

- [ ] `cargo test -p rootray-core` green
- [ ] `pnpm -r test` green (Vitest + Playwright)
- [ ] `pnpm -r typecheck` + `pnpm exec biome check .` green
- [ ] New/updated tests cover the behavior change
- [ ] Verified on the built app (not only dev server)

## Notes

<!-- Risks, follow-ups, screenshots for UI changes. -->

---

**Reminder:** don't include secrets, `.env` contents, or credentials in
code, tests, or fixtures. See [SECURITY.md](../blob/main/SECURITY.md) for
the security model this PR must not weaken.
