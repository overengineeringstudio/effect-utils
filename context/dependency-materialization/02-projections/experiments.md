# Projection Experiments

This file records non-normative projection evidence.

## Pure Install Versus Missing Bins

Hypothesis:

- Missing CLI bins after a strict `--ignore-scripts` install should be fixed by
  projection, not by permitting lifecycle scripts.

Result:

- Real downstream graphs exposed missing app-local bins after pure install.
  Enabling scripts restored the bins but also admitted lifecycle work, which is
  outside the effect-utils trust boundary.

Conclusion:

- Keep lifecycle scripts forbidden and add a pure manifest-based bin projector.

## Prepared FOD Bin Surface

Hypothesis:

- `.bin` entries in prepared dependency FODs are harmless metadata.

Result:

- Rejected. Removing `.bin` changed recursive prepared artifact hashes, so bin
  projection is a real fixed-output surface.

Conclusion:

- Prepared deps must strip and reject `.bin`, then recreate bins in the
  restore/build projection phase.
