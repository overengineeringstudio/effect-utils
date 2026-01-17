# Visual Exploration Skill

Variant-driven UI exploration using Storybook for rapid design iteration.

## Overview

This skill guides systematic visual exploration of UI components through variant combinations. Use when designing complex components with multiple states/configurations.

## Process

### 1. Define Variant Dimensions

Identify independent aspects that can vary:

```
Component: SessionCard
├── Progress display (P1-P4)
├── Waiting state (W1-W3)
├── Working state (A1-A4)
└── Layout density (L1-L2)
```

### 2. Create Variant Picker UI

Each variant dimension gets a colocated picker with inline explanation:

```
┌─────────────────────────────────────────────────────────────────────┐
│ VARIANT CONTROLS                                                    │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│ Progress ────────────────────────────────────────────────────────── │
│ ┌────┐ ┌────┐ ┌────┐ ┌────┐                                         │
│ │ P1 │ │[P2]│ │ P3 │ │ P4 │  ← P2: Phase name + horizontal bar      │
│ └────┘ └────┘ └────┘ └────┘                                         │
│                                                                     │
│ Waiting ─────────────────────────────────────────────────────────── │
│ ┌────┐ ┌────┐ ┌────┐                                                │
│ │[W1]│ │ W2 │ │ W3 │         ← W1: Icon + summary in single line    │
│ └────┘ └────┘ └────┘                                                │
│                                                                     │
│ Working ─────────────────────────────────────────────────────────── │
│ ┌────┐ ┌────┐ ┌────┐ ┌────┐                                         │
│ │ A1 │ │ A2 │ │ A3 │ │[A4]│  ← A4: Summary + status-aware progress  │
│ └────┘ └────┘ └────┘ └────┘                                         │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 3. Storybook Story Structure

```tsx
/** Colocated variant picker with description */
const VariantPicker = <T extends string>({
  label,
  variants,
  value,
  onChange,
}: {
  label: string
  variants: { id: T; description: string }[]
  value: T
  onChange: (v: T) => void
}) => (
  <div className="space-y-2">
    <div className="text-xs font-medium text-gray-700">{label}</div>
    <div className="flex items-center gap-2">
      <div className="flex gap-1">
        {variants.map((v) => (
          <button
            key={v.id}
            onClick={() => onChange(v.id)}
            className={`px-3 py-1 text-sm rounded ${
              value === v.id
                ? "bg-gray-900 text-white"
                : "bg-gray-100 hover:bg-gray-200"
            }`}
          >
            {v.id}
          </button>
        ))}
      </div>
      <span className="text-xs text-gray-500">
        ← {variants.find((v) => v.id === value)?.description}
      </span>
    </div>
  </div>
)

/** Main exploration story */
export const Exploration: Story = {
  render: function Render() {
    const [progress, setProgress] = useState<ProgressVariant>("P2")
    const [waiting, setWaiting] = useState<WaitingVariant>("W1")
    const [working, setWorking] = useState<WorkingVariant>("A4")

    return (
      <div className="space-y-6">
        {/* Variant controls - colocated with descriptions */}
        <div className="p-4 bg-gray-50 rounded-lg space-y-4">
          <VariantPicker
            label="Progress"
            variants={[
              { id: "P1", description: "Minimal bar only" },
              { id: "P2", description: "Phase name + bar" },
              { id: "P3", description: "Pie chart + count" },
              { id: "P4", description: "Status-aware (blocked/complete)" },
            ]}
            value={progress}
            onChange={setProgress}
          />
          <VariantPicker
            label="Waiting"
            variants={[
              { id: "W1", description: "Icon + summary line" },
              { id: "W2", description: "With action hint" },
              { id: "W3", description: "Badge + detail" },
            ]}
            value={waiting}
            onChange={setWaiting}
          />
          <VariantPicker
            label="Working"
            variants={[
              { id: "A1", description: "Summary only" },
              { id: "A2", description: "Summary + phase progress" },
              { id: "A3", description: "Compact with pie" },
              { id: "A4", description: "Full status-aware" },
            ]}
            value={working}
            onChange={setWorking}
          />
        </div>

        {/* Live preview with selected variants */}
        <div className="flex gap-4">
          {/* Render columns with current variant selection */}
        </div>
      </div>
    )
  },
}
```

### 4. Iteration Workflow

1. **Explore**: Use variant picker to try combinations
2. **Document**: Note which combinations work well
3. **Refine**: Create focused stories for winning combinations
4. **Consolidate**: Extract final component with sensible defaults

### 5. Version-Based Iteration

For larger explorations, use **versioned story files** to track design evolution:

```
src/ui/stories/
├── SessionCardV1.stories.tsx  # Initial exploration
├── SessionCardV2.stories.tsx  # Refined after feedback
├── SessionCardV3.stories.tsx  # Semantic sections added
├── SessionCardV4.stories.tsx  # Progress variants refined
└── SessionCardV5.stories.tsx  # Final locked-in decisions
```

**Version workflow:**

1. **V1**: Initial variant exploration (many open questions)
2. **V2+**: Each version locks in decisions from previous feedback
3. **Document locked decisions** at top of each version:

```tsx
/**
 * Session Card V5 - Refined Design
 *
 * Locked in from V4:
 * - Layout: L2 (standard)
 * - Project pill: PP2 with branch
 * - Timing: State-aware
 *
 * Still exploring:
 * - Progress bar hierarchy (PB2a/PB2b/PB2c)
 */
```

**Benefits:**
- Preserve history of design decisions
- Easy to compare versions side-by-side
- Clear audit trail for stakeholder review
- Can revert to previous version if needed

**Naming convention:** `{ComponentName}V{N}.stories.tsx`

### 6. Feedback Collection

When getting user feedback, use clear variant IDs:

```
User feedback format:
- "P2 is best for progress"
- "W1 but with label styling from W3"
- "A4 aligned with P2"
```

This enables precise communication about design decisions.

## Best Practices

1. **Limit dimensions**: Max 3-4 variant dimensions per exploration
2. **Meaningful IDs**: Use short, memorable IDs (P1, W2, A3)
3. **Inline descriptions**: Always show what current selection does
4. **Real data**: Use realistic sample data, not lorem ipsum
5. **State coverage**: Show all relevant states (working, idle, stopped, etc.)
6. **Side-by-side**: Enable easy comparison of variants

## Example Variant Naming

| Prefix | Meaning |
|--------|---------|
| P | Progress indicator |
| W | Waiting state |
| A | Activity/Working state |
| L | Layout/Density |
| S | Stopped state |
| H | Header style |
| F | Footer style |

## When to Use

- Designing new components with multiple states
- Exploring alternative layouts
- Getting stakeholder feedback on design options
- A/B testing visual treatments
- Documenting design decisions
