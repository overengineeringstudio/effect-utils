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
      `"<div class="x1yz74fy x1y0btm7 xmkeg23 x1p074e9 x17o9ork x16wg5c4 outer" data-rac="" role="group"><header class="x1aa13qb x8r4c90 xk50ysn x11jy40w x135yrb0">Primitives &lt;世界&gt;</header><div class="xrvj5dj x1eym4a3"><div class="xrvj5dj x1dpylte" data-rac="" data-disabled="true"><label class="x1aa13qb x8r4c90 x11jy40w" id="react-aria-_R_6H1_" for="react-aria-_R_6_">Email</label><input type="email" disabled="" placeholder="you@example.com" id="email" aria-labelledby="react-aria-_R_6H1_" aria-describedby="react-aria-_R_6H3_ react-aria-_R_6H4_" class="xh8yej3 x13m96dk xb570pk x1aa13qb x8r4c90 x18486fo xmkeg23 x1y0btm7 x1p074e9 xbsmrfh x11jy40w x1a2a7pz x1qhknr x1yrzk5 xijokvz x1s07b3s" data-rac="" data-disabled="true" value=""/><span class="xfifm61 x1rk8jk8" id="react-aria-_R_6H3_" slot="description">résumé@example.com</span></div><div class="xrvj5dj x1dpylte"><div><div class="x1aa13qb x8r4c90 x11jy40w" data-rac="" data-disabled="true"><label data-react-aria-pressable="true" class="x78zum5 x6s0dn4 x1lz7s3o x1ypdohk" data-rac="" data-disabled="true"><span style="border:0;clip:rect(0 0 0 0);clip-path:inset(50%);height:1px;margin:-1px;overflow:hidden;padding:0;position:absolute;width:1px;white-space:nowrap"><input id="enabled" aria-describedby="react-aria-_R_q_ react-aria-_R_qH1_" disabled="" type="checkbox" data-react-aria-pressable="true"/></span><div class="xcdlrvm x1l36t39 x2lah0s x78zum5 x6s0dn4 xl56j7k x18486fo xmkeg23 x1y0btm7 x1p074e9 xbsmrfh xts7igz xx6bhzk"><svg viewBox="0 0 12 12" class="x1jw3ynk xvle69y x1f7m26b xg01cxk x19991ni xx6bhzk" aria-hidden="true"><path d="M3 6l2 2 4-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"></path></svg></div><span>Enabled</span></label></div></div><div class="x1hshjfz xfifm61 x1rk8jk8"></div></div><div class="xrvj5dj x1dpylte"><div><span>bare</span></div><div class="x1hshjfz xfifm61 x1rk8jk8"></div></div></div></div>"`,
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
      `"<div><div class="xrvj5dj x1dpylte" data-rac=""><label class="x1aa13qb x8r4c90 x11jy40w xuxw1ft" id="react-aria-_R_1H2_" for="react-aria-_R_1_">Required</label><input aria-labelledby="react-aria-_R_1H2_" id="required" type="text" autoComplete="off" inputMode="numeric" autoCorrect="off" spellCheck="false" tabindex="0" aria-describedby="react-aria-_R_1H4_ react-aria-_R_1H5_" aria-roledescription="Number field" class="xh8yej3 x13m96dk xb570pk x1aa13qb x8r4c90 x18486fo xmkeg23 x1y0btm7 x1p074e9 xbsmrfh x11jy40w x1a2a7pz x1qhknr xijokvz x1s07b3s" data-rac="" value=""/><span class="xfifm61 x1rk8jk8" id="react-aria-_R_1H4_" slot="description">NaN boundary</span></div><div class="xrvj5dj x1dpylte"><div><div class="x78zum5 x6s0dn4 x1lz7s3o"><label for="optional-off" class="x1aa13qb x8r4c90 x11jy40w xuxw1ft">Optional off</label><input id="optional-off" type="number" disabled="" class="x1tz10n8 x2pyauc x1dus959 x1aa13qb x8r4c90 x18486fo xmkeg23 x1y0btm7 x1p074e9 xbsmrfh x11jy40w x1a2a7pz x1qhknr xijokvz" value=""/><button type="button" role="switch" aria-checked="false" title="Click to enable" class="xcdlrvm x1l36t39 x2lah0s x78zum5 x6s0dn4 xl56j7k x18486fo xmkeg23 x1y0btm7 x1p074e9 xd1alm3 xijokvz"></button></div></div><div class="x1hshjfz xfifm61 x1rk8jk8"></div></div><div class="xrvj5dj x1dpylte"><div><div class="x78zum5 x6s0dn4 x1lz7s3o"><label for="optional-zero" class="x1aa13qb x8r4c90 x11jy40w xuxw1ft">Optional zero</label><input id="optional-zero" type="number" disabled="" class="x1tz10n8 x2pyauc x1dus959 x1aa13qb x8r4c90 x18486fo xmkeg23 x1y0btm7 x1p074e9 xbsmrfh x11jy40w x1a2a7pz x1qhknr xijokvz" value="0"/><button type="button" role="switch" aria-checked="true" title="Click to disable (set to undefined)" disabled="" class="xcdlrvm x1l36t39 x2lah0s x78zum5 x6s0dn4 xl56j7k x18486fo xmkeg23 x1y0btm7 x1p074e9 xd1alm3 xijokvz"><svg width="10" height="10" viewBox="0 0 12 12" style="color:var(--x116mk5h)" aria-hidden="true"><path d="M3 6l2 2 4-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"></path></svg></button></div></div><div class="x1hshjfz xfifm61 x1rk8jk8"></div></div></div>"`,
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
      `"<div class="xrvj5dj x1dpylte"><div><div class="xrvj5dj x9x7wkp"><span class="x1aa13qb x8r4c90 x11jy40w">Role</span><div class="x78zum5 x1yz74fy xmkeg23 x1y0btm7 x1p074e9 xb3r6kr" data-rac="" aria-label="Role" role="radiogroup" aria-orientation="horizontal" aria-disabled="false" data-orientation="horizontal"><button class="x1iyjqo2 xs83m0k x1t1x2f9 x1iypghl x200n1h x1aa13qb x8r4c90 xs1s249 x32b0ac xcojka xs2xxs2 xx6bhzk x1lpyac xr3cle6 x1f7m26b" data-rac="" type="button" tabindex="0" data-react-aria-pressable="true" role="radio" aria-checked="true" data-selected="true">—</button><button class="x1iyjqo2 xs83m0k x1t1x2f9 x1iypghl x200n1h x1aa13qb x8r4c90 xs1s249 x32b0ac xcojka xs2xxs2 xx6bhzk x1lpyac xr3cle6 x1f7m26b" data-rac="" type="button" tabindex="0" data-react-aria-pressable="true" role="radio" aria-checked="true" data-selected="true"></button><button class="x1iyjqo2 xs83m0k x1t1x2f9 x1iypghl x200n1h x1aa13qb x8r4c90 x11jy40w x17o9ork xs1s249 x32b0ac xcojka xs2xxs2 xx6bhzk x1lpyac xd1alm3" data-rac="" type="button" tabindex="0" data-react-aria-pressable="true" role="radio" aria-checked="false">Admin</button><button class="x1iyjqo2 xs83m0k x1t1x2f9 x1iypghl x200n1h x1aa13qb x8r4c90 x11jy40w x17o9ork xs1s249 x32b0ac xcojka xs2xxs2 xx6bhzk x1lpyac xd1alm3" data-rac="" type="button" tabindex="0" data-react-aria-pressable="true" role="radio" aria-checked="false">Some Value</button><button class="x1iyjqo2 xs83m0k x1t1x2f9 x1iypghl x200n1h x1aa13qb x8r4c90 x11jy40w x17o9ork xs1s249 x32b0ac xcojka xs2xxs2 xx6bhzk x1lpyac xd1alm3" data-rac="" type="button" tabindex="0" data-react-aria-pressable="true" role="radio" aria-checked="false">東京</button></div></div></div><div class="x1hshjfz xfifm61 x1rk8jk8"></div></div>"`,
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
      `"<template><span class="xfifm61 x1rk8jk8">Choose</span></template><div class="xrvj5dj x1dpylte" data-rac="" data-disabled="true"><button id="many" class="xh8yej3 x13m96dk xb570pk x1aa13qb x8r4c90 xdpxx8g x78zum5 x6s0dn4 x1qughib x18486fo xmkeg23 x1y0btm7 x1p074e9 xbsmrfh x11jy40w x1a2a7pz x1qhknr xijokvz" data-rac="" type="button" disabled="" data-react-aria-pressable="true" aria-labelledby="react-aria-_R_2H7_ react-aria-_R_2H3_" aria-describedby="react-aria-_R_2H5_ react-aria-_R_2H6_" aria-haspopup="listbox" aria-expanded="false" data-disabled="true"><span id="react-aria-_R_2H7_" class="x1iyjqo2" data-rac="" data-placeholder="true">Select an item</span><svg viewBox="0 0 16 16" class="xcdlrvm x1l36t39 x1rk8jk8" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" fill="none"></path></svg></button><span class="xfifm61 x1rk8jk8">Choose</span><div style="border:0;clip:rect(0 0 0 0);clip-path:inset(50%);height:1px;margin:-1px;overflow:hidden;padding:0;position:fixed;width:1px;white-space:nowrap;top:0;left:0" aria-hidden="true" data-react-aria-prevent-focus="true" data-a11y-ignore="aria-hidden-focus" data-testid="hidden-select-container"><label><select tabindex="-1" disabled=""><option value="" label=" "> </option><option value="">— Select —</option><option value="one">One</option><option value="two">Two</option><option value="three">Three</option><option value="four">Four</option><option value="five">Five</option><option value="six">Six</option></select></label></div></div>"`,
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
            innerSchema: Schema.Tuple([Schema.String]),
          }}
        />
        <FieldGroupEmpty label="Empty Group" />
        <FieldGroupEmpty label="Custom" message="" className="extra" />
      </div>,
    )

    expect(html).toMatchInlineSnapshot(
      `"<div><div class="xrvj5dj x1dpylte xjjyn6y xmkeg23 x1y0btm7 x1p074e9 x18486fo x17o9ork"><span class="x4z9k3i xm5lqql">items</span><span class="xfifm61 x1k4tb9n x1rk8jk8">Unsupported schema type: unknown</span></div><div class="x1yz74fy xmkeg23 x1y0btm7 xt82u6x xtwqqul x1gt5ugr" data-rac="" role="group"><header class="x1aa13qb x8r4c90 xk50ysn x11jy40w xwq89bs">Empty Group</header><span class="xowd3t2 xl2ypbo x1k4tb9n x1rk8jk8">No additional options</span></div><div class="x1yz74fy xmkeg23 x1y0btm7 xt82u6x xtwqqul x1gt5ugr extra" data-rac="" role="group"><header class="x1aa13qb x8r4c90 xk50ysn x11jy40w xwq89bs">Custom</header><span class="xowd3t2 xl2ypbo x1k4tb9n x1rk8jk8"></span></div></div>"`,
    )
  })

  it('renders a complete tagged schema form as byte-identical markup', () => {
    const FormSchema = Schema.TaggedStruct('contact_preferences', {
      name: Schema.String.annotate({ title: 'Name', description: 'Unicode accepted' }),
      count: Schema.optional(Schema.Finite).annotate({ title: 'Count' }),
      enabled: Schema.Boolean,
      mode: Schema.Literals(['email', 'push-notification']),
      items: Schema.Tuple([Schema.String]),
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
      `"<div class="x1yz74fy x1y0btm7 xmkeg23 xt82u6x xtwqqul x1gt5ugr custom" data-rac="" role="group"><header class="x1aa13qb x8r4c90 xk50ysn x11jy40w x135yrb0">Contact Preferences</header><div class="xrvj5dj x1eym4a3"><div class="xrvj5dj x1eym4a3"><div><div class="xrvj5dj x1dpylte" data-rac=""><label class="x1aa13qb x8r4c90 x11jy40w" id="react-aria-_R_6H1_" for="react-aria-_R_6_">Name</label><input type="text" placeholder="" tabindex="0" id="schema-form-name" aria-labelledby="react-aria-_R_6H1_" aria-describedby="react-aria-_R_6H3_ react-aria-_R_6H4_" class="xh8yej3 x13m96dk xb570pk x1aa13qb x8r4c90 x18486fo xmkeg23 x1y0btm7 x1p074e9 xbsmrfh x11jy40w x1a2a7pz x1qhknr x1yrzk5 xijokvz x1s07b3s" data-rac="" value="Ada 世界"/><span class="xfifm61 x1rk8jk8" id="react-aria-_R_6H3_" slot="description">Unicode accepted</span></div></div><div><div class="xrvj5dj x1dpylte"><div><div class="x78zum5 x6s0dn4 x1lz7s3o"><label for="schema-form-count" class="x1aa13qb x8r4c90 x11jy40w xuxw1ft">Count</label><input id="schema-form-count" type="number" disabled="" class="x1tz10n8 x2pyauc x1dus959 x1aa13qb x8r4c90 x18486fo xmkeg23 x1y0btm7 x1p074e9 xbsmrfh x11jy40w x1a2a7pz x1qhknr xijokvz" value=""/><button type="button" role="switch" aria-checked="false" title="Click to enable" class="xcdlrvm x1l36t39 x2lah0s x78zum5 x6s0dn4 xl56j7k x18486fo xmkeg23 x1y0btm7 x1p074e9 xd1alm3 xijokvz"></button></div></div><div class="x1hshjfz xfifm61 x1rk8jk8"></div></div></div><div><div class="xrvj5dj x1dpylte"><div><div class="x1aa13qb x8r4c90 x11jy40w" data-rac=""><label data-react-aria-pressable="true" class="x78zum5 x6s0dn4 x1lz7s3o x1ypdohk" data-rac=""><span style="border:0;clip:rect(0 0 0 0);clip-path:inset(50%);height:1px;margin:-1px;overflow:hidden;padding:0;position:absolute;width:1px;white-space:nowrap"><input id="schema-form-enabled" aria-describedby="react-aria-_R_1e_ react-aria-_R_1eH1_" type="checkbox" data-react-aria-pressable="true" tabindex="0"/></span><div class="xcdlrvm x1l36t39 x2lah0s x78zum5 x6s0dn4 xl56j7k x18486fo xmkeg23 x1y0btm7 x1p074e9 xbsmrfh xts7igz xx6bhzk"><svg viewBox="0 0 12 12" class="x1jw3ynk xvle69y x1f7m26b xg01cxk x19991ni xx6bhzk" aria-hidden="true"><path d="M3 6l2 2 4-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"></path></svg></div><span>enabled</span></label></div></div><div class="x1hshjfz xfifm61 x1rk8jk8"></div></div></div><div><div class="xrvj5dj x1dpylte"><div><div class="xrvj5dj x9x7wkp"><span class="x1aa13qb x8r4c90 x11jy40w">mode</span><div class="x78zum5 x1yz74fy xmkeg23 x1y0btm7 x1p074e9 xb3r6kr" data-rac="" aria-label="mode" role="radiogroup" aria-orientation="horizontal" aria-disabled="false" data-orientation="horizontal"><button class="x1iyjqo2 xs83m0k x1t1x2f9 x1iypghl x200n1h x1aa13qb x8r4c90 x11jy40w x17o9ork xs1s249 x32b0ac xcojka xs2xxs2 xx6bhzk x1lpyac xd1alm3" data-rac="" type="button" tabindex="0" data-react-aria-pressable="true" role="radio" aria-checked="false">Email</button><button class="x1iyjqo2 xs83m0k x1t1x2f9 x1iypghl x200n1h x1aa13qb x8r4c90 xs1s249 x32b0ac xcojka xs2xxs2 xx6bhzk x1lpyac xr3cle6 x1f7m26b" data-rac="" type="button" tabindex="0" data-react-aria-pressable="true" role="radio" aria-checked="true" data-selected="true">Push Notification</button></div></div></div><div class="x1hshjfz xfifm61 x1rk8jk8"></div></div></div><div><div class="xrvj5dj x1dpylte xjjyn6y xmkeg23 x1y0btm7 x1p074e9 x18486fo x17o9ork"><span class="x4z9k3i xm5lqql">items</span><span class="xfifm61 x1k4tb9n x1rk8jk8">Unsupported schema type: unknown</span></div></div></div></div></div>"`,
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

    expect(html).toMatchInlineSnapshot(`"<div class="xrvj5dj x1eym4a3"></div>"`)
  })
})
