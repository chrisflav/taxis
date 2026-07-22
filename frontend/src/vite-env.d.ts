/// <reference types="vite/client" />

// Brings in Vite's ambient module declarations, notably for asset imports such as
// `import("katex/dist/katex.min.css")` — a bare side-effect import needs no types, but the
// dynamic form in `Markdown.tsx` resolves to a module and does.
