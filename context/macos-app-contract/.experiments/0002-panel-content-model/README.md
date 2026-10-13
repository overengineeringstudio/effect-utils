# Experiment: approval panel interior content model

## Question

Date: 2026-10-13. Host: macOS 27, arm64, interactive Aqua session.

Should an approval panel's untrusted display interior be a declarative JSON
spec rendered by AppKit (A), or a pinned local HTML/CSS bundle rendered by
WKWebView (B)? The native shell, not the interior, owns trusted identity,
geometry and Allow/Deny/TTL state.

## Method

[`Probe.swift`](./Probe.swift) uses one 640×502 pt nonactivating native panel,
a 94 pt identity header, a 640×350 pt interior and a 58 pt native footer.
A synthetic record stands in for a validated server record. Neither renderer
can set that record or reach an approval callback. The controls are experiment
controls, not a working server integration or a signed production host.

A decodes generated JSON into a bounded list of plain-text paragraphs and
renders a read-only, selectable NSTextView in an NSScrollView. The spec permits
no arbitrary views, geometry, attributed text, controls, URLs or callbacks.
B loads the checked-in [`index.html`](./index.html), copied unchanged to a
local bundle directory. It uses `loadFileURL`, read access limited to that
directory, a nonpersistent data store, native viewport layer clipping, a
navigation delegate admitting only the initial exact file URL, a UI delegate
that suppresses dialogs/denies new webviews, disabled element fullscreen and
content rules blocking HTTP(S), WS(S) and FTP. JavaScript is enabled solely
to exercise attacks; production can disable it if unnecessary. There is no
script-message bridge. The source is a fixed local fixture, not an implemented
signed-manifest verifier. Bundle integrity checks remain a production concern.

Both fixtures contain 500 repetitions of a long phrase, one 12,000-character
unbroken token, RTL text, emoji and 200 list items. B additionally attempts
fixed positioning, negative coordinates/margins, transforms, visible overflow,
fullscreen, `window.open`, `alert`, external navigation, network fetch and a
`file:` fetch of a synthetic sentinel outside the permitted directory.

The executable never orders a window, activates the application or requests
system AX access. Activation policy is prohibited. It does not sign anything,
install jobs, read credentials or request consent. `windowVisible` and
`windowKey` were false for every measured run. Offscreen NSAccessibility
protocol traversal inspects in-process views only.

Time starts at executable entry, including `ps`, AppKit setup, local rule-list
compilation, document load, render readiness, snapshot and PNG encoding. It
ends at the first saved composite frame. This is a fresh-process launch, not a
cold OS-cache benchmark, and excludes process-loader time. RSS is sampled
before shell snapshot encoding; WebKit has already taken its interior snapshot.
Additional WebKit processes are a PID difference between `ps` before setup
and while the view is alive, not a count of all WebKit processes on the host.
Their RSS is measured separately. The host was not otherwise quiesced.

For web snapshots, capture the native shell with WKWebView hidden, then
composite `takeSnapshot` at the reserved interior rect. This avoids unreliable
remote-layer capture with AppKit `cacheDisplay`. These images show each
renderer and the shell's reserved geometry; they do **not** establish behavior
of the live on-screen window compositor. All runs use light appearance.

Expiry is driven by the shell's record/time reconciliation, first with a fresh
record and then a virtual time after its deadline. Separate executable launches
also start with already-expired records, independently of the live renderer.
The experiment does not implement a real server refresh or expiry timer.

### Reproduce (offscreen only)

From the worktree root, with the system Swift compiler:

```sh
mkdir -p tmp/m0-panel/bundle
/usr/bin/swiftc context/macos-app-contract/.experiments/0002-panel-content-model/Probe.swift -o tmp/m0-panel/probe
cp context/macos-app-contract/.experiments/0002-panel-content-model/index.html tmp/m0-panel/bundle/index.html
printf 'SYNTHETIC_OUTSIDE_PINNED_DIRECTORY' > tmp/m0-panel/outside.txt
tmp/m0-panel/probe native "$PWD/tmp/m0-panel"
tmp/m0-panel/probe web "$PWD/tmp/m0-panel"
tmp/m0-panel/probe native "$PWD/tmp/m0-panel" expired
tmp/m0-panel/probe web "$PWD/tmp/m0-panel" expired
```

No window-ordering command is part of this procedure. Snapshots and generated
JSON reports stay in gitignored scratch, not in this experiment directory.

## Observations

Final fixture measurements, one sample per row (not statistical estimates):

| Measurement | A: declarative AppKit | B: pinned WKWebView |
| --- | ---: | ---: |
| Fresh-process first saved frame | 439.14 ms | 758.78 ms |
| Host resident memory before shell PNG capture | 52.97 MiB | 80.34 MiB |
| Additional WebKit processes | 0 | 3 |
| Additional service RSS | 0 MiB | 92.34 MiB |
| Approx. host + additional service RSS | 52.97 MiB | 172.69 MiB |
| Panel / interior dimensions | 640×502 / 640×350 pt | 640×502 / 640×350 pt |
| Interior list items / huge token length | 200 / 12,000 | 200 / 12,000 |
| Local AX nodes enumerated | 14 | 7 |
| Local AX interior text codepoints | 19,964 | Not exposed by this traversal |
| Native Allow enabled, fresh / expired | true / false | true / false |
| Native Allow enabled at expired process launch | false | false |
| Expired process-launch first saved frame | 405.17 ms | 755.35 ms |

B's three new services were WebContent (45.03 MiB), Networking (19.75 MiB)
and GPU (27.56 MiB). PID-delta attribution is strong temporal evidence, not a
claim that PPID alone proves ownership (the XPC services report PPID 1).
RSS sums do not deduplicate shared pages. Snapshot composition/encoding
inflates host RSS substantially (about 221 MiB A / 246 MiB B afterward), so it
must not be mistaken for the panel's steady-state memory requirement.

### Geometry and spoofing

- Frames remained panel `{0,0,640,502}`, interior `{0,94,640,350}` and footer
  `{0,444,640,58}`. B's document was 10,461 CSS pixels high inside a 350 pt
  viewport. The saved stress images retain shell identity and footer controls;
  B's oversized magenta escape layer remains confined to its interior snapshot.
- A reproduces the identity string and the word “Allow” as untrusted plain
  text, but cannot reproduce shell typography/layout or create an interior
  button with this restricted spec. Textual identity deception is still possible.
- B visibly reproduces a second identity header with the shell's font/size and
  a convincing blue “Allow” button inside its interior. The demonstrated button
  is not pixel-identical to this harness's gray native Allow button; no claim of
  pixel-exact indistinguishability is made. Arbitrary HTML styling permits a
  much stronger visual impersonation surface than A. Clipping prevents frame
  escape, **not** duplication of trusted-looking UI within that frame.

Snapshot names: `native-stress.png`, `web-stress.png`, `native-expired.png`,
`web-expired.png`, `native-restart-stress.png`, `web-restart-stress.png`,
`native-restart-expired.png`, `web-restart-expired.png`.

### Web attack outcomes

| Attempt | Observed result | Required boundary / limitation |
| --- | --- | --- |
| Fixed position, negative margin, transform, overflow | Huge paint stays within interior snapshot; shell frames unchanged | Native frame ownership and `masksToBounds`, never DOM-driven shell sizing |
| External navigation | Delegate canceled 1 navigation to synthetic external URL | Admit initial exact local URL once; deny subsequent main/subframe navigation |
| Network fetch | Promise rejected with `TypeError` | Content-rule blocking installed before load; rejection alone is not a packet-level no-egress proof |
| Outside-directory file fetch | Promise rejected with `TypeError`; sentinel not returned | Narrow `allowingReadAccessTo`; no host file-reading bridge. Fetch/CORS failure alone does not establish every possible file-read route |
| Fullscreen | `TypeError`; no fullscreen entered | Native fullscreen preference disabled; offscreen/no-gesture conditions also constrain this attempt |
| `window.open` | Returned null; 0 new-view delegate callbacks | Popup did not open; offscreen conditions may reject it before delegate. Still install a nil-returning UI delegate in production |
| `alert()` | 1 UI delegate callback completed without a dialog | Handle all JS dialog callbacks without opening native UI |

A has no CSS, JS, navigation or file/network execution surface in the spec.
Its defenses are schema bounds, plain-text-only rendering, native style/geometry
ownership and scroll/clipping. Adding arbitrary native widgets or attributed
content would invalidate that narrower security result.

### Accessibility and expiry

Both AX dumps expose distinct native AXButton elements labeled Allow and Deny;
Allow is disabled in the post-expiry tree while Deny remains enabled. TTL is a
separate native AXPopUpButton. A's AXTextArea contains the entire 19,964-codepoint
payload, including item 200, RTL text and emoji, rather than only visible lines.
B's in-process NSAccessibility traversal exposes an AXGroup but not the remote
web text tree. **B interior accessibility is unproven by this offscreen method**;
DOM readability is not substituted for AX evidence. No system AX permission was
requested to work around this limitation.

The fake web Allow remains visible after expiration, while the native shell
Allow is disabled. Actual separate expired process launches start disabled in
both models. Interior display cannot modify the record or shell control state.
Production must also recheck record identity, phase, deadline and TTL at action
dispatch and obtain authoritative server acceptance; a disabled button alone
is not an authorization boundary.

## Conclusions

Recommend **A: a constrained declarative native spec** for the approval panel
interior. This sample starts about 1.7× faster, uses about 3.3× less combined
host/service RSS, exposes full text directly through in-process AX, and removes
browser execution/navigation/popup surfaces. More importantly, keeping style,
layout and actionable controls out of the spec reduces visual impersonation.
Do not turn A into a general native view-description language: a small set of
text/detail/list blocks is the useful constraint.

B can preserve native shell geometry and expiry ownership, but native clipping
alone does not make arbitrary HTML trustworthy. If chosen for richer content,
keep identity and decision controls exclusively native, make the untrusted
region unmistakable, interpolate untrusted data as text into a reviewed pinned
template, enforce bundle integrity before load, disable JS unless needed, and
retain navigation/UI/network/file boundaries even for local content. Resolve
remote AX behavior and measure live compositor containment before claiming
production parity. Neither model prevents malicious plain-text persuasion.

## Open

These are deliberately unperformed on-screen checks for a later interactive
session; this experiment must not be used to infer focus behavior:

- [ ] Showing a nonactivating panel does not activate the app, steal focus,
      move the insertion point or consume the foreground application's typing.
- [ ] Intended window level works over ordinary/fullscreen windows and across
      Spaces, Stage Manager and multiple displays, without changing app focus.
- [ ] Clicking the interior, selecting text, scrolling and using TTL give the
      intended key-window/first-responder behavior; HTML autofocus cannot seize
      focus or redirect keys intended for native controls.
- [ ] Tab/Shift-Tab order reaches native TTL, Deny and Allow distinctly; no
      Return/Space shortcut accidentally approves on first appearance or page change.
- [ ] Esc and native close dismiss according to shell policy, including while
      interior text/control has focus; they never approve or open web dialogs.
- [ ] Clicking a fake interior Allow cannot dispatch native approval or alter
      TTL/identity; identity remains visibly distinguishable at normal viewing scale.
- [ ] Live compositor clips fixed-position/transformed/overflow content to the
      viewport during scrolling, resizing attempts and animation; verify no
      overlap of the native header/footer on Retina and non-Retina displays.
- [ ] With a real user gesture, fullscreen, popup, navigation and all JS dialog
      paths still cannot create another window, open another app or steal focus.
- [ ] VoiceOver/Accessibility Inspector exposes readable B text and separate
      shell controls, announces expiry/disabled Allow and does not present fake
      interior controls as trusted decisions; check A reading order and RTL too.
- [ ] Deadline passes while panel is open/backgrounded, machine sleeps/wakes,
      or renderer stalls/crashes; native Allow disables and dispatch fails closed.
- [ ] Restart with a server-expired/removed review never briefly arms Allow;
      replay/reconnect and page changes cannot reuse a stale decision or TTL.

Additional noninteractive follow-up: packet-level egress observation, additional
file-read routes using only synthetic sentinels, signed-bundle integrity,
repeated launch/resource measurements and WebKit service crash/recovery. No
on-screen behavior, production signing or real-server integration is proven here.
