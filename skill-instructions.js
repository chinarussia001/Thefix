const SKILL_INSTRUCTIONS = Object.freeze({
  "interface-premium": {
    name: "Premium Interface",
    instruction: "Create a distinctive, polished interface with deliberate hierarchy, spacing, typography, and interaction states. Prefer coherent product-specific design over generic decoration, and preserve usability and responsive behavior.",
  },
  "git-safe": {
    name: "Safe Git",
    instruction: "Inspect repository status and diffs before editing. Preserve unrelated user changes, make the smallest focused patch, avoid destructive Git commands and force pushes, and verify the final diff and relevant checks.",
  },
  "tests-regression": {
    name: "Testing & Regression",
    instruction: "Identify the behavior affected by the change and validate its success, failure, and important edge cases with the narrowest relevant tests. Preserve existing behavior and state clearly which checks could not be run.",
  },
  responsive: {
    name: "Responsiveness",
    instruction: "Design and verify the requested experience across narrow and wide viewports. Prevent overflow, clipped content, unstable controls, and unusable touch targets while preserving the desktop workflow.",
  },
  performance: {
    name: "Performance",
    instruction: "Prioritize measurable bottlenecks and reduce unnecessary work, network activity, memory use, and rendering cost without weakening correctness. Avoid speculative optimization and validate meaningful performance changes.",
  },
  "security-review": {
    name: "Security Review",
    instruction: "Consider trust boundaries, input validation, authentication, authorization, data exposure, and least privilege relevant to this task. Do not expose secrets or weaken existing controls; distinguish verified vulnerabilities from speculation.",
  },
  "responsivo-completo": {
    name: "Complete Responsiveness",
    instruction: "Review the affected screens at mobile, tablet, and desktop sizes, including orientation changes and long content. Correct layout, overflow, sizing, and touch interaction issues without changing unrelated behavior.",
  },
  "corrigir-projeto": {
    name: "Fix Project",
    instruction: "Reproduce or isolate the reported failure, trace it to its root cause, and apply the smallest fix that restores the requested behavior. Add or run a regression check and avoid unrelated cleanup.",
  },
  "seguranca-e-banco": {
    name: "Security & Database",
    instruction: "For relevant data-layer changes, verify authorization at the data boundary, row-level access rules, input constraints, and safe handling of migrations and secrets. Preserve existing access policy and report any unverified assumptions.",
  },
  "melhorar-ui-ux": {
    name: "Improve UI/UX",
    instruction: "Improve clarity, feedback, hierarchy, and task completion in the requested user flow. Keep controls predictable and accessible, retain existing capabilities, and avoid adding steps or visual changes unrelated to the request.",
  },
  "refatorar-projeto": {
    name: "Refactor Project",
    instruction: "Improve structure only where it directly serves the requested work. Preserve public behavior and interfaces, keep the refactor bounded, and use relevant tests or comparisons to detect regressions.",
  },
  "otimizar-projeto": {
    name: "Optimize Project",
    instruction: "Find the specific cost or latency relevant to the task, prefer simple changes with measurable benefit, and preserve correctness and maintainability. Do not add caching, concurrency, or complexity without evidence it helps.",
  },
  "accessibility-wcag": {
    name: "Accessibility (WCAG)",
    instruction: "Apply WCAG 2.1 AA considerations to the affected experience: semantic structure, keyboard operation, visible focus, labels, contrast, and appropriate ARIA. Do not claim conformance without checking the relevant criteria.",
  },
  "agent-ui-design": {
    name: "Agent UI Design",
    instruction: "For agent, chat, or tool interfaces, make user intent, agent status, progress, results, and recovery states clear. Keep human control visible and ensure actions, streaming content, and errors remain understandable.",
  },
  "ai-design-workflow": {
    name: "AI Design Workflow",
    instruction: "Use an iterative design workflow: clarify constraints, produce a focused implementation, and verify it against the requested outcome. Treat generated ideas as proposals that require human review, not as authority to expand scope.",
  },
  "audit-code-quality": {
    name: "Audit Code Quality",
    instruction: "Examine the relevant code for correctness, duplication, cohesion, and maintainability. Prioritize concrete defects and material risks, support findings with code evidence, and do not turn an audit into unrelated refactoring.",
  },
  "audit-cost-explosion": {
    name: "Audit Cost Explosion",
    instruction: "For relevant services and data flows, look for unbounded calls, repeated queries, oversized payloads, uncontrolled retries, and expensive uploads or functions. Quantify or qualify evidence and avoid changing billing or quotas.",
  },
  "audit-legal-risks": {
    name: "Audit Legal Risks",
    instruction: "Identify concrete privacy, data-retention, terms, licensing, jurisdiction, and intellectual-property concerns relevant to the task. Separate technical observations from legal conclusions and do not present this review as legal advice.",
  },
  "audit-monitoring-recovery": {
    name: "Audit Monitoring & Recovery",
    instruction: "Review relevant failure signals, logging, alerting, backups, recovery paths, and operational visibility. Identify gaps that affect detection or restoration and do not claim resilience without evidence.",
  },
  "audit-secrets-data-leaks": {
    name: "Audit Secrets & Data Leaks",
    instruction: "Check relevant code and data paths for exposed credentials, sensitive logging, excessive access, unsafe storage, and leakage through APIs or errors. Never reproduce secret values in output; recommend rotation if exposure is evidenced.",
  },
  "audit-unauthorized-access": {
    name: "Audit Unauthorized Access",
    instruction: "Trace identity and authorization checks from the entry point to the protected resource. Test ownership, role, and object-level boundaries where relevant, and report bypasses with evidence without weakening controls.",
  },
  "branding-identity": {
    name: "Branding & Identity",
    instruction: "Keep the requested experience consistent with the product's established name, visual identity, tone, and audience. Strengthen consistency where relevant without inventing brand claims or replacing existing identity without instruction.",
  },
  "cloud-migration": {
    name: "Cloud Migration",
    instruction: "For an explicitly requested cloud migration, inventory current services, dependencies, data, access policies, and operational requirements before proposing staged changes. Preserve data and security boundaries, and never assume migration is requested by an unrelated task.",
  },
  "color-theory": {
    name: "Color Theory",
    instruction: "Use color purposefully for hierarchy, state, contrast, and brand coherence. Check text and control contrast, avoid conveying meaning by color alone, and preserve the existing palette unless the request calls for a change.",
  },
  "component-patterns": {
    name: "Component Patterns",
    instruction: "Use component composition and variants that fit the existing framework and codebase conventions. Keep responsibilities clear, reuse established primitives, and avoid introducing abstractions for one-off behavior without a concrete benefit.",
  },
  "customer-journey": {
    name: "Customer Journey",
    instruction: "Consider the user's goal, entry point, decisions, feedback, and completion or recovery path in the affected flow. Remove relevant friction while preserving user agency and do not add unrelated funnel or tracking behavior.",
  },
  "design-process": {
    name: "Design Process",
    instruction: "Work from the stated brief and constraints through a focused design decision, implementation, and validation. Explain material tradeoffs and keep discovery or deliverables proportional to the requested change.",
  },
  "design-system-pro": {
    name: "Design System Pro",
    instruction: "Use consistent design tokens, type, spacing, color, and component states where the project already defines them. Extend the system only when needed, keep choices reusable, and verify the affected states and viewports.",
  },
  "ux-design": {
    name: "UX Design",
    instruction: "Optimize the requested flow for understandable choices, clear feedback, error recovery, and low cognitive load. Follow established platform conventions and preserve capabilities and user control.",
  },
  "vibe-security-check": {
    name: "Vibe Security Check",
    instruction: "Review the affected feature against practical OWASP-style risks, including injection, broken access control, insecure data handling, and unsafe configuration. Prioritize exploitable evidence and preserve existing protections.",
  },
  "visual-direction": {
    name: "Visual Direction",
    instruction: "Establish a coherent visual direction suited to the product and request, aligning palette, typography, imagery, and layout. Prefer real project-relevant assets and avoid decorative choices that reduce clarity or usability.",
  },
  "web-typography": {
    name: "Web Typography",
    instruction: "Improve typographic hierarchy, readable line lengths, sizing, and wrapping for the affected web experience. Use available project fonts and robust fallbacks, and account for loading, zoom, and small screens.",
  },
  "webdesign-review": {
    name: "Webdesign Review",
    instruction: "Review the affected web experience across layout, hierarchy, interaction, accessibility, responsiveness, and consistency. Prioritize evidence-based issues by impact and keep any implementation within the user's requested scope.",
  },
  "website-audit-relaunch": {
    name: "Website Audit & Relaunch",
    instruction: "For a requested website audit or relaunch, assess technical health, usability, content, SEO, and conversion paths using available evidence. Prioritize recommendations, preserve existing functionality, and do not claim metrics or results that were not measured.",
  },
  "design-trends-2026": {
    name: "Design Trends 2026",
    instruction: "Consider current visual patterns such as expressive type, purposeful motion, and immersive storytelling only when they fit the product and request. Favor performance, accessibility, and durable usability over novelty for its own sake.",
  },
  "images-media": {
    name: "Images & Media",
    instruction: "Choose media that directly supports the content, preserve useful crop and resolution, and account for loading cost, responsive behavior, and accessible alternatives. Do not substitute decorative imagery for information the user needs to inspect.",
  },
  "landing-pages": {
    name: "Landing Pages",
    instruction: "For a requested landing page, align the headline, supporting content, proof, and calls to action with the actual offer and audience. Keep the primary action clear, accessible, responsive, and truthful; avoid inventing claims.",
  },
  "navigation-design": {
    name: "Navigation Design",
    instruction: "Make information architecture and navigation labels predictable, scannable, and usable on touch and keyboard. Preserve current routes and state, expose the user's location where helpful, and avoid adding navigation unrelated to the request.",
  },
  "responsive-design": {
    name: "Responsive Design",
    instruction: "Use fluid, content-driven layouts that adapt from small screens upward. Check wrapping, overflow, media, controls, and touch use at representative widths without relying on a single device-specific breakpoint.",
  },
  "ui-design": {
    name: "UI Design",
    instruction: "Make the affected interface clear and consistent through deliberate grid, spacing, hierarchy, tokens, and interaction states. Follow the existing design system and ensure visual choices do not obscure content or controls.",
  },
  "ui-patterns": {
    name: "UI Patterns",
    instruction: "Use familiar, fit-for-purpose patterns for the requested components, such as forms, cards, calls to action, and page sections. Keep semantics and states complete, and avoid adding patterns that do not serve the task.",
  },
  usability: {
    name: "Usability",
    instruction: "Evaluate the affected flow for visibility of system status, clear mapping, error prevention, recovery, and reduced unnecessary effort. Validate with the actual interaction and preserve user choice rather than relying on appearance alone.",
  },
});

function normalizeSkillIds(selectedSkills) {
  if (!Array.isArray(selectedSkills)) return [];

  const selected = [];
  const seen = new Set();
  for (const id of selectedSkills) {
    if (typeof id !== "string" || seen.has(id) || !Object.prototype.hasOwnProperty.call(SKILL_INSTRUCTIONS, id)) continue;
    seen.add(id);
    selected.push(id);
    if (selected.length === 42) break;
  }
  return selected;
}

export function getPromptSkillIds(payload, fallbackSkills) {
  const hasExplicitSkills = payload != null && Object.prototype.hasOwnProperty.call(payload, "skills");
  return normalizeSkillIds(hasExplicitSkills ? payload.skills : fallbackSkills);
}

export function withSkillInstructions(prompt, selectedSkills) {
  if (typeof prompt !== "string") return prompt;
  const selected = normalizeSkillIds(selectedSkills).map((id) => SKILL_INSTRUCTIONS[id]);
  if (!selected.length) return prompt;

  const guidance = selected.map(({ name, instruction }) => `- ${name}: ${instruction}`).join("\n");
  return `${prompt}\n\n[LovaRPM selected Skill guidance]\nApply all compatible guidance below as supplemental direction. The user's original task and explicit constraints remain primary. Do not replace, truncate, duplicate, or broaden the task. If guidance conflicts, honor the user's explicit request and apply only relevant guidance.\n${guidance}`;
}