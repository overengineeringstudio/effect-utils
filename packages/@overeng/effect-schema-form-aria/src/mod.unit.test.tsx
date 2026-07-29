import { Schema } from 'effect'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import {
  AriaSchemaForm,
  BooleanField,
  FieldGroup,
  FieldGroupEmpty,
  FieldWrapper,
  LiteralField,
  NumberField,
  TextField,
  UnknownField,
} from './mod.ts'

describe('effect-schema-form-aria baselines (cross-major invariant)', () => {
  it('renders text, boolean, and field wrapper bytes for empty, unicode, hinted, and disabled values', () => {
    const html = renderToStaticMarkup(
      <FieldGroup label="Primitives <世界>" className="outer">
        <TextField
          id="email"
          label="Email"
          value=""
          onChange={vi.fn()}
          hint="résumé@example.com"
          type="email"
          placeholder="you@example.com"
          isDisabled
        />
        <BooleanField
          id="enabled"
          label="Enabled"
          value={false}
          onChange={vi.fn()}
          hint=""
          isDisabled
        />
        <FieldWrapper description={undefined}>
          <span>bare</span>
        </FieldWrapper>
      </FieldGroup>,
    )

    expect(html).toMatchInlineSnapshot(
      `"<div class="rounded-lg border border-border bg-surface p-4 outer" data-rac="" role="group"><header class="text-sm font-medium text-ink mb-3">Primitives &lt;世界&gt;</header><div class="grid gap-4"><div class="grid gap-1.5" data-rac="" data-disabled="true"><label class="text-sm text-ink" id="react-aria-_R_6H1_" for="react-aria-_R_6_">Email</label><input type="email" disabled="" placeholder="you@example.com" id="email" aria-labelledby="react-aria-_R_6H1_" aria-describedby="react-aria-_R_6H3_ react-aria-_R_6H4_" class="w-full px-2.5 py-2 text-sm rounded border border-border bg-input text-ink placeholder:text-subtle-ink focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed" data-rac="" data-disabled="true" value=""/><span class="text-[12px] text-subtle-ink" id="react-aria-_R_6H3_" slot="description">résumé@example.com</span></div><div class="grid gap-1.5"><div><div class="text-sm text-ink" data-rac="" data-disabled="true"><label data-react-aria-pressable="true" class="group flex items-center gap-2 cursor-pointer" data-rac="" data-disabled="true"><span style="border:0;clip:rect(0 0 0 0);clip-path:inset(50%);height:1px;margin:-1px;overflow:hidden;padding:0;position:absolute;width:1px;white-space:nowrap"><input id="enabled" aria-describedby="react-aria-_R_q_ react-aria-_R_qH1_" disabled="" type="checkbox" data-react-aria-pressable="true"/></span><div class="size-4 shrink-0 rounded border border-border bg-input group-data-[selected]:bg-primary group-data-[selected]:border-primary flex items-center justify-center transition-colors"><svg viewBox="0 0 12 12" class="size-3 text-white opacity-0 group-data-[selected]:opacity-100 transition-opacity" aria-hidden="true"><path d="M3 6l2 2 4-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"></path></svg></div><span>Enabled</span></label></div></div><div class="min-h-[16px] text-[12px] text-subtle-ink"></div></div><div class="grid gap-1.5"><div><span>bare</span></div><div class="min-h-[16px] text-[12px] text-subtle-ink"></div></div></div></div>"`,
    )
  })

  it('renders required and optional number field bytes across undefined, zero, and disabled states', () => {
    const html = renderToStaticMarkup(
      <div>
        <NumberField
          id="required"
          label="Required"
          value={undefined}
          onChange={vi.fn()}
          hint="NaN boundary"
        />
        <NumberField
          id="optional-off"
          label="Optional off"
          value={undefined}
          onChange={vi.fn()}
          isOptional
        />
        <NumberField
          id="optional-zero"
          label="Optional zero"
          value={0}
          onChange={vi.fn()}
          isOptional
          isDisabled
        />
      </div>,
    )

    expect(html).toMatchInlineSnapshot(
      `"<div><div class="grid gap-1.5" data-rac=""><label class="text-sm text-ink" id="react-aria-_R_1H2_" for="react-aria-_R_1_">Required</label><input aria-labelledby="react-aria-_R_1H2_" id="required" type="text" autoComplete="off" inputMode="numeric" autoCorrect="off" spellCheck="false" tabindex="0" aria-describedby="react-aria-_R_1H4_ react-aria-_R_1H5_" aria-roledescription="Number field" class="w-full px-2.5 py-2 text-sm rounded border border-border bg-input text-ink focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed" data-rac="" value=""/><span class="text-[12px] text-subtle-ink" id="react-aria-_R_1H4_" slot="description">NaN boundary</span></div><div class="grid gap-1.5"><div><div class="flex items-center gap-2"><label for="optional-off" class="text-sm text-ink whitespace-nowrap">Optional off</label><input id="optional-off" type="number" disabled="" class="w-20 px-2 py-0.5 text-sm rounded border border-border bg-input text-ink focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50" value=""/><button type="button" role="switch" aria-checked="false" title="Click to enable" class="size-4 shrink-0 rounded border border-border flex items-center justify-center hover:bg-surface-raised disabled:opacity-50"></button></div></div><div class="min-h-[16px] text-[12px] text-subtle-ink"></div></div><div class="grid gap-1.5"><div><div class="flex items-center gap-2"><label for="optional-zero" class="text-sm text-ink whitespace-nowrap">Optional zero</label><input id="optional-zero" type="number" disabled="" class="w-20 px-2 py-0.5 text-sm rounded border border-border bg-input text-ink focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50" value="0"/><button type="button" role="switch" aria-checked="true" title="Click to disable (set to undefined)" disabled="" class="size-4 shrink-0 rounded border border-border flex items-center justify-center hover:bg-surface-raised disabled:opacity-50"><svg width="10" height="10" viewBox="0 0 12 12" class="text-accent" aria-hidden="true"><path d="M3 6l2 2 4-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"></path></svg></button></div></div><div class="min-h-[16px] text-[12px] text-subtle-ink"></div></div></div>"`,
    )
  })

  it('renders segmented literal bytes at the five-option boundary including optional empty selection', () => {
    const html = renderToStaticMarkup(
      <LiteralField
        id="role"
        label="Role"
        value={undefined}
        onChange={vi.fn()}
        literals={['', 'admin', 'someValue', '東京']}
        hint=""
        isOptional
      />,
    )

    expect(html).toMatchInlineSnapshot(
      `"<div class="grid gap-1.5"><div><div class="grid gap-1"><span class="text-sm text-ink">Role</span><div class="flex rounded-lg border border-border overflow-hidden" data-rac="" aria-label="Role" role="radiogroup" aria-orientation="horizontal" aria-disabled="false" data-orientation="horizontal"><button class="flex-1 px-3 py-1.5 text-sm text-ink bg-surface hover:bg-surface-raised data-[selected]:bg-primary data-[selected]:text-white transition-colors border-r border-border last:border-r-0" data-rac="" type="button" tabindex="0" data-react-aria-pressable="true" role="radio" aria-checked="true" data-selected="true">—</button><button class="flex-1 px-3 py-1.5 text-sm text-ink bg-surface hover:bg-surface-raised data-[selected]:bg-primary data-[selected]:text-white transition-colors border-r border-border last:border-r-0" data-rac="" type="button" tabindex="0" data-react-aria-pressable="true" role="radio" aria-checked="true" data-selected="true"></button><button class="flex-1 px-3 py-1.5 text-sm text-ink bg-surface hover:bg-surface-raised data-[selected]:bg-primary data-[selected]:text-white transition-colors border-r border-border last:border-r-0" data-rac="" type="button" tabindex="0" data-react-aria-pressable="true" role="radio" aria-checked="false">Admin</button><button class="flex-1 px-3 py-1.5 text-sm text-ink bg-surface hover:bg-surface-raised data-[selected]:bg-primary data-[selected]:text-white transition-colors border-r border-border last:border-r-0" data-rac="" type="button" tabindex="0" data-react-aria-pressable="true" role="radio" aria-checked="false">Some Value</button><button class="flex-1 px-3 py-1.5 text-sm text-ink bg-surface hover:bg-surface-raised data-[selected]:bg-primary data-[selected]:text-white transition-colors border-r border-border last:border-r-0" data-rac="" type="button" tabindex="0" data-react-aria-pressable="true" role="radio" aria-checked="false">東京</button></div></div></div><div class="min-h-[16px] text-[12px] text-subtle-ink"></div></div>"`,
    )
  })

  it('renders select literal bytes above the segmented boundary with an out-of-domain value', () => {
    const html = renderToStaticMarkup(
      <LiteralField
        id="many"
        label={undefined}
        value="missing"
        onChange={vi.fn()}
        literals={['one', 'two', 'three', 'four', 'five', 'six']}
        hint="Choose"
        isOptional
        isDisabled
      />,
    )

    expect(html).toMatchInlineSnapshot(
      `"<template><span class="text-[12px] text-subtle-ink">Choose</span></template><div class="grid gap-1.5" data-rac="" data-disabled="true"><button id="many" class="w-full px-2.5 py-2 text-sm rounded border border-border bg-input text-ink text-left flex items-center justify-between focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50" data-rac="" type="button" disabled="" data-react-aria-pressable="true" aria-labelledby="react-aria-_R_2H7_ react-aria-_R_2H3_" aria-describedby="react-aria-_R_2H5_ react-aria-_R_2H6_" aria-haspopup="listbox" aria-expanded="false" data-disabled="true"><span id="react-aria-_R_2H7_" class="flex-1" data-rac="" data-placeholder="true">Select an item</span><svg viewBox="0 0 16 16" class="size-4 text-subtle-ink" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" fill="none"></path></svg></button><span class="text-[12px] text-subtle-ink">Choose</span><div style="border:0;clip:rect(0 0 0 0);clip-path:inset(50%);height:1px;margin:-1px;overflow:hidden;padding:0;position:fixed;width:1px;white-space:nowrap;top:0;left:0" aria-hidden="true" data-react-aria-prevent-focus="true" data-a11y-ignore="aria-hidden-focus" data-testid="hidden-select-container"><label><select tabindex="-1" disabled=""><option value="" label=" "> </option><option value="">— Select —</option><option value="one">One</option><option value="two">Two</option><option value="three">Three</option><option value="four">Four</option><option value="five">Five</option><option value="six">Six</option></select></label></div></div>"`,
    )
  })

  it('renders unsupported and empty-group bytes instead of failing', () => {
    const html = renderToStaticMarkup(
      <div>
        <UnknownField
          fieldKey="items"
          meta={{
            type: 'unknown',
            title: undefined,
            description: undefined,
            literals: undefined,
            isOptional: false,
            innerSchema: Schema.Tuple(Schema.String),
          }}
        />
        <FieldGroupEmpty label="Empty Group" />
        <FieldGroupEmpty label="Custom" message="" className="extra" />
      </div>,
    )

    expect(html).toMatchInlineSnapshot(
      `"<div><div class="grid gap-1.5 p-2 border border-border rounded bg-surface"><span class="text-[13px] text-muted-ink">items</span><span class="text-[12px] text-subtle-ink italic">Unsupported schema type: unknown</span></div><div class="rounded-lg border border-border/50 bg-surface/30 p-3 " data-rac="" role="group"><header class="text-sm font-medium text-ink mb-2">Empty Group</header><span class="text-xs text-subtle-ink italic">No additional options</span></div><div class="rounded-lg border border-border/50 bg-surface/30 p-3 extra" data-rac="" role="group"><header class="text-sm font-medium text-ink mb-2">Custom</header><span class="text-xs text-subtle-ink italic"></span></div></div>"`,
    )
  })

  it('renders a complete tagged schema form as byte-identical markup', () => {
    const FormSchema = Schema.TaggedStruct('contact_preferences', {
      name: Schema.String.annotate({ title: 'Name', description: 'Unicode accepted' }),
      count: Schema.optional(Schema.Number).annotate({ title: 'Count' }),
      enabled: Schema.Boolean,
      mode: Schema.Literal('email', 'push-notification'),
      items: Schema.Tuple(Schema.String),
    })

    const html = renderToStaticMarkup(
      <AriaSchemaForm
        schema={FormSchema}
        value={{
          _tag: 'contact_preferences',
          name: 'Ada 世界',
          enabled: false,
          mode: 'push-notification',
          items: [''],
        }}
        onChange={vi.fn()}
        className="custom"
      />,
    )

    expect(html).toMatchInlineSnapshot(
      `"<div class="rounded-lg border border-border/50 bg-surface/30 p-3 custom" data-rac="" role="group"><header class="text-sm font-medium text-ink mb-3">Contact Preferences</header><div class="grid gap-4"><div class="grid gap-4 "><div><div class="grid gap-1.5" data-rac=""><label class="text-sm text-ink" id="react-aria-_R_6H1_" for="react-aria-_R_6_">Name</label><input type="text" placeholder="" tabindex="0" id="schema-form-name" aria-labelledby="react-aria-_R_6H1_" aria-describedby="react-aria-_R_6H3_ react-aria-_R_6H4_" class="w-full px-2.5 py-2 text-sm rounded border border-border bg-input text-ink placeholder:text-subtle-ink focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed" data-rac="" value="Ada 世界"/><span class="text-[12px] text-subtle-ink" id="react-aria-_R_6H3_" slot="description">Unicode accepted</span></div></div><div><div class="grid gap-1.5"><div><div class="flex items-center gap-2"><label for="schema-form-count" class="text-sm text-ink whitespace-nowrap">Count</label><input id="schema-form-count" type="number" disabled="" class="w-20 px-2 py-0.5 text-sm rounded border border-border bg-input text-ink focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50" value=""/><button type="button" role="switch" aria-checked="false" title="Click to enable" class="size-4 shrink-0 rounded border border-border flex items-center justify-center hover:bg-surface-raised disabled:opacity-50"></button></div></div><div class="min-h-[16px] text-[12px] text-subtle-ink">a number</div></div></div><div><div class="grid gap-1.5"><div><div class="text-sm text-ink" data-rac=""><label data-react-aria-pressable="true" class="group flex items-center gap-2 cursor-pointer" data-rac=""><span style="border:0;clip:rect(0 0 0 0);clip-path:inset(50%);height:1px;margin:-1px;overflow:hidden;padding:0;position:absolute;width:1px;white-space:nowrap"><input id="schema-form-enabled" aria-describedby="react-aria-_R_1e_ react-aria-_R_1eH1_" type="checkbox" data-react-aria-pressable="true" tabindex="0"/></span><div class="size-4 shrink-0 rounded border border-border bg-input group-data-[selected]:bg-primary group-data-[selected]:border-primary flex items-center justify-center transition-colors"><svg viewBox="0 0 12 12" class="size-3 text-white opacity-0 group-data-[selected]:opacity-100 transition-opacity" aria-hidden="true"><path d="M3 6l2 2 4-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"></path></svg></div><span>boolean</span></label></div></div><div class="min-h-[16px] text-[12px] text-subtle-ink">a boolean</div></div></div><div><div class="grid gap-1.5"><div><div class="grid gap-1"><span class="text-sm text-ink">mode</span><div class="flex rounded-lg border border-border overflow-hidden" data-rac="" aria-label="mode" role="radiogroup" aria-orientation="horizontal" aria-disabled="false" data-orientation="horizontal"><button class="flex-1 px-3 py-1.5 text-sm text-ink bg-surface hover:bg-surface-raised data-[selected]:bg-primary data-[selected]:text-white transition-colors border-r border-border last:border-r-0" data-rac="" type="button" tabindex="0" data-react-aria-pressable="true" role="radio" aria-checked="false">Email</button><button class="flex-1 px-3 py-1.5 text-sm text-ink bg-surface hover:bg-surface-raised data-[selected]:bg-primary data-[selected]:text-white transition-colors border-r border-border last:border-r-0" data-rac="" type="button" tabindex="0" data-react-aria-pressable="true" role="radio" aria-checked="true" data-selected="true">Push Notification</button></div></div></div><div class="min-h-[16px] text-[12px] text-subtle-ink"></div></div></div><div><div class="grid gap-1.5 p-2 border border-border rounded bg-surface"><span class="text-[13px] text-muted-ink">items</span><span class="text-[12px] text-subtle-ink italic">Unsupported schema type: unknown</span></div></div></div></div></div>"`,
    )
  })

  it('keeps invalid schema roots in the empty-render partition', () => {
    const html = renderToStaticMarkup(
      <AriaSchemaForm
        schema={Schema.String as unknown as Schema.Schema<Record<string, unknown>>}
        value={{}}
        onChange={vi.fn()}
      />,
    )

    expect(html).toMatchInlineSnapshot(`"<div class="grid gap-4 "></div>"`)
  })
})
