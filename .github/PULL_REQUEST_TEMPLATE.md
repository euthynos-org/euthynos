## What this changes

<!-- and why. Link the issue if there is one. -->

## Checklist

- [ ] Every commit is signed off (`git commit -s`) per the [DCO](../DCO)
- [ ] `npm test` passes (685 tests)
- [ ] `npx tsc --noEmit` is clean
- [ ] No test was weakened to make this pass
- [ ] No tool output claims more than it can support (see CONTRIBUTING.md)

## If this touches measurement

- [ ] `node scripts/measurement/audit-harness-args.mjs` exits 0 for any harness I changed
- [ ] Any new performance figure is reproducible from a valid, schema-checked,
      fail-closed run and states its methodology, machine and sample count
- [ ] I have read `BENCHMARK-INTEGRITY-AUDIT.md`
