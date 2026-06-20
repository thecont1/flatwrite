# FlatWrite — Regression Test Cases

Manual test plan covering all features built through the redesign.
Run after any change to index.html, styles.css, or app.js.

---

## 1. Mode Switching (Edit / View / Read)

### 1.1 Edit → View → Edit
- [ ] Start in Edit mode (Edit button highlighted)
- [ ] Click "View" — preview fades in from top, Edit button unhighlights, View highlights
- [ ] Click "Edit" — editor returns, View unhighlights, Edit highlights
- [ ] No vertical scroll jump in either direction

### 1.2 Edit → Read → Edit
- [ ] Click "Read" — preview fades in, focus mode activates, logo animates
- [ ] "Read" label changes to "Close" in the mode-switch pill
- [ ] Edit and View labels are hidden; only Close visible
- [ ] Click "Close" — returns to Edit mode, logo animates back
- [ ] No vertical scroll jump

### 1.3 Edit → Read → View (Close returns to previous mode)
- [ ] Enter View mode, then click "Read"
- [ ] Click "Close" — returns to View (not Edit)
- [ ] Verify: Close button remembers the mode you came from

### 1.4 View → Read → View
- [ ] From View, click "Read"
- [ ] Click "Close" — returns to View mode directly
- [ ] No flash of Edit mode

### 1.5 Scroll preservation
- [ ] In Edit mode, scroll the textarea to the middle of a long document
- [ ] Switch to View — preview scrolls to approximately the same position
- [ ] Switch back to Edit — textarea scroll position is exactly where you left it
- [ ] Same test: Edit → Read → Edit preserves scroll
- [ ] Same test: View → Read → View preserves scroll

---

## 2. Desktop Layout (wide screen, > 760px)

### 2.1 Three-zone layout
- [ ] Left sidebar visible with logo, tagline, components, framework selector, zoom
- [ ] Central canvas fills remaining width (no max-width cap on main-panel)
- [ ] Right reserve zone visible at fixed 56px minimum
- [ ] Canvas content area has rounded corners on all sides

### 2.2 Toolbar layout
- [ ] Formatting buttons (H1-H4, B, I, S, etc.) on the extreme LEFT of toolbar
- [ ] Edit/View/Read mode-switch on the extreme RIGHT of toolbar
- [ ] Toolbar scrolls horizontally with edge fade when buttons overflow

### 2.3 Read mode (desktop)
- [ ] Logo floats from sidebar to the LEFT edge of toolbar (not the right)
- [ ] Formatting toolbar fades out (opacity: 0)
- [ ] Only the Close button visible in the mode-switch
- [ ] Sidebar fades out
- [ ] Width handles hidden

### 2.4 Width handles
- [ ] Two vertical bars visible in View mode (left and right of preview)
- [ ] Each bar has a small rounded-rectangle knob centered vertically
- [ ] Dragging a handle adjusts content width (400–1400px range)
- [ ] Handles grow and change to accent color on hover
- [ ] Width persists across mode switches

---

## 3. Mobile Layout (< 760px)

### 3.1 Header
- [ ] Hamburger icon fixed at top-left (14px from left, 16px from top)
- [ ] FlatWrite logo fixed next to hamburger (same horizontal line)
- [ ] Edit/View/Read mode-switch fixed at top-right (same horizontal line as logo)
- [ ] Formatting toolbar below the header on its own line
- [ ] Gap between header and toolbar is small (48px top padding on main-inner)

### 3.2 Sidebar drawer
- [ ] Tap hamburger — sidebar slides in from the left
- [ ] Backdrop appears behind sidebar
- [ ] Tap backdrop — sidebar slides back out
- [ ] Toolbar dims when drawer is open

### 3.3 Read mode (mobile)
- [ ] Hamburger fades out
- [ ] Logo stays visible
- [ ] Close button visible at top-right, aligned horizontally with logo
- [ ] Formatting toolbar collapses completely (display: none, height: 0)
- [ ] Textarea expands upward to fill the toolbar space
- [ ] Gap between header and textarea is minimal (56px top padding in focus-mode)
- [ ] Click "Close" — returns to previous mode, hamburger reappears

### 3.4 WCAG touch targets
- [ ] All toolbar buttons at least 44×44px
- [ ] Component buttons at least 44×44px
- [ ] Framework dropdown at least 44px tall
- [ ] Font dropdown button at least 44px tall

---

## 4. Font & Typography Controls

### 4.1 Font dropdown
- [ ] Click font selector — dropdown appears with all fonts listed
- [ ] Each font name renders in its own typeface (Merriweather looks serif, Inter looks sans-serif, etc.)
- [ ] Selecting a font updates the preview/Read view immediately
- [ ] Font persists across sessions (localStorage)

### 4.2 Size controls (+/−)
- [ ] Click "+" — text size increases, document width stays rock solid
- [ ] Click "−" — text size decreases, document width stays rock solid
- [ ] Width handles do NOT move when size changes
- [ ] Size range: 76% to 146% of base (8 steps)
- [ ] Size persists across sessions

### 4.3 Weight controls (+/−)
- [ ] Click "+" — text weight increases (bolder)
- [ ] Click "−" — text weight decreases (lighter)
- [ ] Weight persists across sessions

### 4.4 Line height controls (+/−)
- [ ] Click "+" — line spacing increases
- [ ] Click "−" — line spacing decreases
- [ ] Line height persists across sessions

---

## 5. Preview & Read Mode Content

### 5.1 Links in preview
- [ ] All links in preview/Read mode open in new tab (target="_blank")
- [ ] Links have rel="noopener noreferrer"

### 5.2 Fade-in animation
- [ ] Entering View or Read from Edit triggers smooth fade-in from top
- [ ] Animation is 0.35s, content slides down ~12px while fading in
- [ ] No animation when switching between View and Read directly
- [ ] Rapid toggling doesn't break the animation (reflow forced)

### 5.3 Content width
- [ ] Content width adjustable from 400px to 1400px
- [ ] Width handles positioned correctly at content edges
- [ ] Width persists across mode switches and sessions

---

## 6. Editor Textarea

### 6.1 Scrollbars
- [ ] No visible scrollbar in the textarea (hidden via CSS)
- [ ] Content is still scrollable (scrollbar-width: none + webkit override)

### 6.2 Corners
- [ ] Edit mode: rounded top corners (12px), rounded bottom corners (var(--radius-inner))
- [ ] View mode: same rounded corners on preview iframe
- [ ] Read mode: same rounded corners
- [ ] No size change (not even 1px) when switching between modes

### 6.3 Border
- [ ] Edit mode: 1px border on top, left, right (no bottom)
- [ ] View mode: same border on preview iframe
- [ ] Read mode: same border
- [ ] Border color: rgba(180, 160, 200, 0.3)

---

## 7. Export

### 7.1 Export Markdown
- [ ] Click export MD button — downloads .md file

### 7.2 Export HTML
- [ ] Click export HTML button — downloads .html file with inline styles

### 7.3 Export PDF
- [ ] Click export PDF button — generates PDF via print dialog

---

## 8. Persistence (localStorage)

### 8.1 State survives page reload
- [ ] Font choice persists
- [ ] Size/weight/line-height steps persist
- [ ] Content width persists
- [ ] Current framework persists
- [ ] Document content persists
- [ ] Mode (Edit/View/Read) persists

### 8.2 State survives browser close/reopen
- [ ] All of the above survive a full browser restart

---

## 9. Framework Support

### 9.1 Framework switching
- [ ] Framework dropdown lists all available frameworks
- [ ] Selecting a framework updates the preview with framework-specific styles
- [ ] Framework persists across sessions

### 9.2 Framework-specific rendering
- [ ] Preview applies framework CSS classes
- [ ] Framework JS loads and executes in the sandboxed iframe

---

## 10. Edge Cases

### 10.1 Empty document
- [ ] Edit mode: placeholder text visible ("Start writing your markdown here…")
- [ ] View mode: empty preview, no errors
- [ ] Read mode: empty preview, no errors

### 10.2 Rapid mode switching
- [ ] Quickly toggle Edit → View → Read → Edit → View — no visual glitches
- [ ] No leftover animation classes
- [ ] No orphaned floating logo elements

### 10.3 Window resize
- [ ] Resize from desktop to mobile — layout adapts correctly
- [ ] Resize from mobile to desktop — layout adapts correctly
- [ ] Mode-switch and logo positioning updates

### 10.4 Long documents
- [ ] Scroll performance is smooth in Edit mode
- [ ] Scroll performance is smooth in View/Read mode
- [ ] Scroll ratio preservation works for long documents
