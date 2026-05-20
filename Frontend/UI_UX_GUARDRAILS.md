# UI/UX Guardrails (Master Contract)
**Version:** 1.0  
**Status:** Locked default for all UI changes

This file defines the mandatory UX/UI baseline for this project so users do not need to restate design standards in every request.

## 1) Default Behavior (Always On)
- Treat these guardrails as default requirements for all UI edits.
- Do not introduce unfamiliar interaction patterns unless they clearly improve outcomes and are explicitly requested.
- Preserve consistency with current mental models (Jakob's Law).
- Reduce cognitive load by chunking and prioritizing essential information (Miller's Law).

## 2) Core UX Principles
- **Immediate status visibility:** Show progress/state near the primary action area.
- **Reduce unnecessary scrolling:** Keep critical actions and critical feedback within the same viewport whenever feasible.
- **Predictable flow:** Upload -> Configure -> Generate -> Preview must remain clear and stable.
- **Minimize novelty:** Avoid surprising layout jumps, hidden controls, or unconventional gestures.
- **Error clarity:** Error messages must be direct, actionable, and placed near the relevant control.

## 3) UI Baseline (Must Match App Standards)
- Design language: Apple HiG-inspired Light Mode.
- Background: `#f8fafc`, cards: `white`.
- Accent: Indigo-600 (`#4f46e5`) for primary actions.
- Header: sticky glass style (`white/80`, blur).
- Radius: large curvature (`2.5rem` cards, `3.5rem` image canvas).
- Typography: Inter hierarchy.
- Label standard: instructions textarea remains `"Prompt details"`.

## 4) Interaction Guardrails
- Minimum touch target for buttons/inputs: visually and functionally accessible (`>=44px` intent).
- Keep primary CTA visible and context-aware (disabled states must explain why).
- Progress components must include:
  - clear headline
  - secondary status text
  - progress indicator
  - step checklist (when processing has multiple phases)

## 5) Change Control
- If a new UI request conflicts with this file, require explicit user confirmation before overriding.
- If a change causes UX inconsistency ("เพี้ยน"), revert to this baseline and re-apply incrementally.

## 6) Ready-to-Use Review Checklist
- [ ] Critical info appears near the user’s current task (no unnecessary scroll).
- [ ] Existing UI language and controls remain familiar.
- [ ] Cognitive load is reduced (clear grouping, no overloaded panels).
- [ ] Primary action and current status are visible and understandable.
- [ ] Mobile and desktop both keep key flow intact.
- [ ] No conflict with LINE sticker compliance rules in `Agents.md`.
