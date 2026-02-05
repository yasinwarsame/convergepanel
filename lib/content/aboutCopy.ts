/**
 * Shared Content for About Page and Signup/Login Intro
 * 
 * This is the single source of truth for ConvergePanel's core messaging.
 * Used by:
 * - app/about/page.tsx (About page)
 * - app/signup/page.tsx (Signup page intro)
 * - app/login/page.tsx (Login page intro)
 * 
 * IMPORTANT: When updating this content, ensure it matches across all pages.
 * The About page and signup/login intro should always use identical copy
 * for overlapping sections.
 */

export const aboutCopy = {
  // Main headline (used in signup/login hero)
  headline: {
    before: "Know when to trust AI,",
    accent: "not just what it says.",
  },

  // Subheadline/description (used in signup/login and About page)
  subheadline: {
    before: "ConvergePanel is a ",
    accent: "deep-research",
    after: ", multi-LLM expert panel. Every question is treated like a research brief, not a quick chat reply.",
  },

  // Detailed description (used in About page "What is ConvergePanel?" section)
  detailedDescription: "ConvergePanel is a Multi-LLM Expert Panel research tool that sends one user question to multiple AI models in parallel, then synthesizes a unified answer while explicitly highlighting where models agree or disagree.",

  // Key benefits (bullet points used in signup/login and About page)
  benefits: [
    {
      text: "Treats every query as a deep research brief.",
      accent: "deep research", // Part to highlight with accent color
    },
    {
      text: "Synthesizes a unified answer across top AI models.",
    },
    {
      text: "Maps where the models strongly agree vs. diverge.",
    },
    {
      text: "Surfaces possible biases and blind spots in each answer.",
      accent: "biases and blind spots", // Part to highlight with accent color
    },
    {
      text: "Builds a trust summary so you see consensus, uncertainty, and risk.",
    },
  ],

  // Use case description (used in signup/login footer)
  useCaseDescription: "Built for researchers, founders, analysts, and anyone who needs the deepest possible answer—not just a single AI opinion.",

  // Why multi-model convergence matters (used in About page)
  whyItMatters: {
    title: "Why Multi-Model Convergence Matters",
    description: "Different AI models have different strengths, training data, and reasoning approaches. By querying multiple models simultaneously, you get:",
    points: [
      {
        label: "Consensus validation",
        text: "When multiple models agree, you can have higher confidence in the answer.",
      },
      {
        label: "Perspective diversity",
        text: "Different models may surface different aspects or nuances of a topic.",
      },
      {
        label: "Conflict detection",
        text: "Disagreements highlight areas where the answer is uncertain or contested.",
      },
    ],
  },

  // Models information (used in About page)
  models: {
    title: "Models in MVP",
    description: "ConvergePanel v1 supports five leading AI models:",
    list: [
      {
        name: "GPT 5.1",
        description: "OpenAI's GPT-4 model, known for broad knowledge and reasoning.",
      },
      {
        name: "Claude Opus 4.5",
        description: "Anthropic's Claude, focused on helpfulness and safety.",
      },
      {
        name: "Grok 4",
        description: "X.AI's Grok, designed for real-time information access.",
      },
      {
        name: "Perplexity Pro",
        description: "Perplexity AI, optimized for research and citations.",
      },
      {
        name: "Gemini 3 Pro",
        description: "Google's Gemini, offering advanced multimodal capabilities.",
      },
    ],
  },
};
