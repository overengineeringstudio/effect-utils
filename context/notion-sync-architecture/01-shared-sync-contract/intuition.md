# Shared Sync Contract Intuition

*For: maintainers extracting reusable sync concepts · Assumes: stack-wide
Notion sync architecture · Covers: shared vocabulary, not implementation*

This node is for the reusable shape of sync, not a reusable engine.

When two systems both talk about a desired state, observed state, base snapshot,
digest, checkpoint, guard, mutation plan, or apply result, those words should
mean compatible things. The implementation that computes them can still differ.
