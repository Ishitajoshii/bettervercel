Better Vercel IEEE-style paper

Deliverables
- bettervercel-ieee-paper.pdf: rendered and visually reviewed paper.
- bettervercel-ieee-paper.tex: editable IEEEtran conference-mode LaTeX source.

Author information has deliberately been omitted because it was not supplied.
Add verified author names, affiliations, and email addresses before submission.
No specific conference or journal template was supplied. This is an IEEE-style
conference paper; confirm the chosen venue's page limit and submission rules.

The PDF uses US Letter, two columns, Times New Roman, 10-point body text,
24-point title, numbered sections, a vector figure, a results table, and
numbered references. The editable source uses IEEEtran
with commonly available LaTeX packages and can be compiled with pdfLaTeX in
Overleaf or a full TeX installation. LaTeX was not compiled in this workspace;
its pagination can differ from the visually reviewed PDF.

Reproduction
paper_content.json contains the paper's text; build_paper.py produces the PDF
and LaTeX source using ReportLab and pypdf. Source implementation reviewed:
494f973135b7633474ee8cbdf0cebf90d09aa30c.
Fresh npm run check on October 24, 2026: 86 passed, 0 failed, 0 skipped.
This included TypeScript checks, API bundling, and Node tests.

Evidence files (local, unpublished; do not distribute credential files)
- .build/cli-smoke-1792781813797/results.json
- .build/spa-smoke-1792787072799/results.json
- .build/spa-smoke-1792787072799/verification.json
- .build/release-gate-api-1792787103467.json
- .build/github-rollout-results.json
- TODO.md and project documentation for remaining acceptance work.

The paper distinguishes current local test results from retained live evidence.
Individual timing observations are not distributions, and there is no measured
comparison against another hosting provider. No author identity, performance
benchmark, cost saving, or completed acceptance check has been invented.
