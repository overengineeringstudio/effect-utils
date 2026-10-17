# Devtools Ontology

## Language

These terms belong to the shared devtools system. Effect's scope, runtime,
metric, and tracer retain their upstream meanings; request, capture policy,
and inspector client retain their [explorer meanings](../effect-rpc-explorer/ontology.md).

- **Source:** An owner of observations for one typed series, with an explicit acquisition lifetime. A source describes where evidence comes from, not how it is drawn.
- **Cadence:** The trigger class for source observation: each frame, a periodic interval, or an event. Cadence is independent of presentation frequency.
- **SeriesStore:** The shared owner of bounded series histories and their read views. Readers observe history without consuming it.
- **Series:** An identified, typed sequence of timestamped observations, including unavailable observations and gaps. A series carries the label and unit needed to interpret its values.
- **FrameClock:** The shared sequence of visible frame opportunities within a meters session. It coordinates frame-driven observation and drawing without making a renderer the owner of collection.
- **Renderer:** A consumer that projects series evidence into a visual, textual, or headless representation. Rendering does not acquire the underlying source.
- **Strip:** A contiguous visual surface containing meter blocks. A strip is one presentation of evidence, not an independent collection session.
- **Block:** The history-and-value presentation for a selected meter within a strip. _Avoid_: source, when referring to a drawing region.
- **Segment:** Host-supplied status or action content in the bar outside the meter strip. A connection-status segment is not itself a diagnostic connection.
- **Panel:** A detail surface associated with a selectable diagnostic view and displayed above the bar. _Avoid_: block, when referring to an expanded detail surface.
- **Host:** The application that owns the runtime, transports, enabling policy, and composition of diagnostics. _Avoid_: collector, when referring to the integrating application.
- **Enabling boundary:** The host-controlled boundary separating absent diagnostics from loaded and acquired diagnostics. Visibility of an already acquired renderer is not this boundary.
- **Measure bracket:** A bounded observation interval with an explicit beginning and ending, producing cumulative deltas and an evidence-completeness outcome. It differs from a continuously moving trailing window.
- **Sink:** A recipient of lifecycle observations from a shared protocol observer. A sink chooses its own projection without owning transport interception or another sink's policy.

## Structure

```text
Host
  contains: enabling boundary, diagnostic composition
  diagnostic composition
    Sources --Cadence--> SeriesStore --Series--> Renderers
                          |                       +-- Strip --contains--> Blocks
                          |                       +-- accessible text / tooltip
                          |                       +-- headless / measure brackets
                          +-------------------------- Panel detail evidence
    bar: Strip + panel controls + host Segments
    protocol observer --fan-out--> Sinks
                                   +-- RPC meter projection
                                   +-- explorer capture projection
```

The primary measurement anchor is **Series**: a source produces it, a store
retains it, and renderers project it. Cadence and renderer kind are independent
facets. Blocks are parts of a strip; panels and segments are sibling
presentation concepts, not alternate source names. A measure bracket depends
on cumulative source evidence rather than the strip's frozen view.
