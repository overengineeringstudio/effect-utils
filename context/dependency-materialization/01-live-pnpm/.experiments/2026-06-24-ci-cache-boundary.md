# 2026-06-24 CI Cache Boundary

## Question

Is the pnpm Store Cache alone the best warm-install cache boundary for the
measured pnpm 11 and GVS realization?

## Method

Compared warm installs after restoring only the Store Cache with installs after
restoring the measured full pnpm hot-state boundary.

## Result

Restoring pnpm home reused more of the hot path than restoring only the Store
Cache in the measured GVS realization.

## Conclusion

The Store Cache alone was not the complete hot-state boundary in that historical
realization. Current CI remains job-local, and any future reusable artifact must
derive its boundary from declared identity rather than ambient pnpm home state.

## VRS Impact

Supports DMP.LIVE-R10's job-local CI boundary and DMP-R24's requirement for a
declared Hermetic Dependency Artifact identity.
