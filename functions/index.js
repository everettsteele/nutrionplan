const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const Anthropic = require('@anthropic-ai/sdk');

admin.initializeApp();
setGlobalOptions({ region: 'us-central1' });

const PLAN_SCHEMA_VERSION = 1;

// ── Prompt builder ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a precision nutrition and training coach. Your job is to generate a fully personalized, evidence-based plan based on a user's inputs. You return only valid JSON — no markdown, no explanation, no commentary. Your output will be parsed directly by a machine.

The plan must be realistic, specific, and immediately actionable. Do not use filler meals or generic advice. Every meal should have accurate macros. Every recipe should be cookable by a normal person in a normal kitchen.`;

function buildPrompt(inputs) {
  const goalLabel = {
    lose_fat: 'fat loss (reduce body fat while preserving muscle)',
    build_muscle: 'muscle building (maximize lean mass gains)',
    recomp: 'body recomposition (simultaneous fat loss and muscle building)',
  }[inputs.goal] || inputs.goal;

  const dietLabel = {
    omnivore: 'omnivore (eats everything)',
    pescatarian: 'pescatarian (no meat, fish and seafood OK)',
    vegetarian: 'vegetarian (no meat or fish, dairy and eggs OK)',
    vegan: 'fully vegan (no animal products of any kind)',
  }[inputs.diet] || inputs.diet;

  const cookingLabel = {
    minimal: 'minimal — wants simple, fast meals with no batch cooking required',
    moderate: 'moderate — willing to batch cook once or twice per week',
    full: 'full prep — will do whatever the plan requires',
  }[inputs.cookingLevel] || inputs.cookingLevel;

  const allergyList = inputs.allergies && inputs.allergies.length
    ? inputs.allergies.join(', ')
    : 'none';

  const equipmentList = inputs.equipment && inputs.equipment.length
    ? inputs.equipment.join(', ')
    : 'not specified';

  const supplementList = inputs.supplementsInclude === 'no'
    ? 'none requested'
    : inputs.supplements && inputs.supplements.length
      ? inputs.supplements.join(', ')
      : 'open to evidence-based recommendations';

  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const trainingDayNames = (inputs.trainingDays || []).map(d => dayNames[d]).join(', ');

  return `Generate a complete nutrition and training plan for the following person:

GOALS
- Primary goal: ${goalLabel}
- Current weight: ${inputs.currentWeight} ${inputs.weightUnit}
- Goal weight: ${inputs.goalWeight} ${inputs.weightUnit}
- Current body fat: ${inputs.currentBf ? inputs.currentBf + '%' : 'not provided'}
- Timeline: ${inputs.timeline || 8} weeks

DIET
- Diet type: ${dietLabel}${inputs.dietNotes ? '\n- Additional diet notes: ' + inputs.dietNotes : ''}
- Allergies and foods to avoid: ${allergyList}${inputs.allergyNotes ? '\n- Additional allergy notes: ' + inputs.allergyNotes : ''}
- Cooking comfort level: ${cookingLabel}

TRAINING
- Training days per week: ${inputs.trainingDaysPerWeek}
- Training days: ${trainingDayNames} (0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat)
- Training type: ${inputs.trainingType}
- Equipment available: ${equipmentList}

SUPPLEMENTS
- Supplement preference: ${inputs.supplementsInclude}
- Supplements: ${supplementList}${inputs.supplementNotes ? '\n- Supplement notes: ' + inputs.supplementNotes : ''}

CONSTRAINTS
- Never include ingredients the user is allergic to or has listed as avoided
- Respect the diet type strictly
- Macro targets must reflect a realistic deficit or surplus for the stated goal
- Protein must be at least 0.8g per lb of current body weight, ideally 1g/lb
- Carbs and calories should cycle: higher on training days, lower on rest days
- Cooking complexity must match the stated cooking comfort level
- All 7 days of the week must be covered (days 0–6)
- Training days must exactly match the trainingDays array provided
- Generate at least 6 recipes, maximum 12
- Shopping list must cover exactly one week of the plan
- Prep plan should have at most 2 sessions per week (e.g. Sunday + one other)

Return a single JSON object matching this exact schema. No markdown fences. No keys outside this schema. No null values — use empty strings or empty arrays instead.

{
  "weeklyPlan": {
    "0": {
      "type": "training or rest",
      "meals": [
        {
          "time": "string (e.g. 7–8 AM)",
          "name": "string",
          "desc": "string (brief description of what it is)",
          "cal": number,
          "p": number,
          "c": number,
          "f": number
        }
      ]
    },
    "1": { "type": "...", "meals": [...] },
    "2": { "type": "...", "meals": [...] },
    "3": { "type": "...", "meals": [...] },
    "4": { "type": "...", "meals": [...] },
    "5": { "type": "...", "meals": [...] },
    "6": { "type": "...", "meals": [...] }
  },
  "macroTargets": {
    "training": { "cal": number, "p": number, "c": number, "f": number },
    "rest":     { "cal": number, "p": number, "c": number, "f": number }
  },
  "recipes": [
    {
      "name": "string",
      "cat": "Batch Cook or Salads & Bowls or Quick Meals",
      "prep": "string (e.g. 10 min)",
      "cook": "string (e.g. 20 min)",
      "serves": number,
      "macros": { "cal": number, "p": number, "c": number, "f": number },
      "ingredients": ["string"],
      "steps": ["string"]
    }
  ],
  "prepPlan": {
    "sun": {
      "label": "string (e.g. COVERS MON → WED DINNERS)",
      "items": [
        { "id": "s1", "name": "string", "note": "string", "time": "string (e.g. 25 min passive)" }
      ]
    },
    "thu": {
      "label": "string",
      "items": [
        { "id": "t1", "name": "string", "note": "string", "time": "string" }
      ]
    }
  },
  "shoppingList": [
    {
      "cat": "string (e.g. PROTEINS, PRODUCE, PANTRY)",
      "items": [
        { "id": "sh1", "name": "string", "qty": "string (e.g. 500g, 2 cans, or empty string)" }
      ]
    }
  ],
  "supplements": ["string (each supplement as a plain string recommendation)"],
  "notes": "string (any important notes about the plan, or empty string)"
}`;
}

// ── Validator ───────────────────────────────────────────────────────────────

function validatePlan(plan) {
  if (!plan || typeof plan !== 'object') throw new Error('Plan must be an object');
  if (!plan.weeklyPlan || typeof plan.weeklyPlan !== 'object') throw new Error('Missing weeklyPlan');

  for (const dow of ['0', '1', '2', '3', '4', '5', '6']) {
    const d = plan.weeklyPlan[dow];
    if (!d) throw new Error(`Missing day ${dow} in weeklyPlan`);
    if (!d.type || !['training', 'rest'].includes(d.type)) throw new Error(`Day ${dow} has invalid type: ${d.type}`);
    if (!Array.isArray(d.meals) || d.meals.length === 0) throw new Error(`Day ${dow} has no meals`);
    for (const m of d.meals) {
      if (!m.name) throw new Error(`Meal in day ${dow} missing name`);
      if (m.cal == null || m.p == null || m.c == null || m.f == null) {
        throw new Error(`Meal "${m.name}" in day ${dow} missing macro fields`);
      }
    }
  }

  if (!plan.macroTargets || !plan.macroTargets.training || !plan.macroTargets.rest) {
    throw new Error('Missing or incomplete macroTargets');
  }

  if (!Array.isArray(plan.recipes) || plan.recipes.length === 0) throw new Error('Missing recipes array');
  if (!Array.isArray(plan.shoppingList) || plan.shoppingList.length === 0) throw new Error('Missing shoppingList');
  if (!plan.prepPlan || !plan.prepPlan.sun || !plan.prepPlan.thu) throw new Error('Missing prepPlan.sun or prepPlan.thu');
}

// ── Cloud Function ──────────────────────────────────────────────────────────

exports.generatePlan = onCall({ timeoutSeconds: 300, memory: '512MiB' }, async (request) => {
  // Auth check
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be signed in to generate a plan.');
  }
  const uid = request.auth.uid;

  // Input validation
  const { wizardInputs } = request.data;
  if (!wizardInputs || !wizardInputs.goal || !wizardInputs.currentWeight || !wizardInputs.goalWeight) {
    throw new HttpsError('invalid-argument', 'Wizard inputs are incomplete. Required: goal, currentWeight, goalWeight.');
  }

  // API key
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY environment variable not set');
    throw new HttpsError('internal', 'API key not configured. Contact the app owner.');
  }

  const client = new Anthropic({ apiKey });
  const prompt = buildPrompt(wizardInputs);

  let plan = null;

  // Call Claude with one automatic retry on failure
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const message = await client.messages.create({
        model: 'claude-opus-4-6',
        max_tokens: 8000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = message.content[0].text.trim();
      // Strip markdown code fences if model wraps in them
      const jsonStr = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      plan = JSON.parse(jsonStr);
      validatePlan(plan);
      break; // success — exit retry loop
    } catch (err) {
      console.error(`Plan generation attempt ${attempt + 1} failed:`, err.message);
      if (attempt === 1) {
        throw new HttpsError('internal', `Plan generation failed after 2 attempts: ${err.message}`);
      }
      // brief pause before retry
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Persist to Firestore
  const db = admin.firestore();
  const userRef = db.collection('users').doc(uid);
  const snap = await userRef.get();
  const existing = snap.exists ? (snap.data().planMeta || {}) : {};
  const version = (existing.version || 0) + 1;

  const now = new Date();
  const timelineWeeks = parseInt(wizardInputs.timeline) || 8;
  const startDate = now.toISOString().split('T')[0];
  const endMs = now.getTime() + timelineWeeks * 7 * 24 * 60 * 60 * 1000;
  const endDate = new Date(endMs).toISOString().split('T')[0];

  await userRef.set({
    wizardInputs,
    plan,
    planMeta: {
      createdAt: existing.createdAt || now.toISOString(),
      updatedAt: now.toISOString(),
      version,
      timelineWeeks,
      startDate,
      endDate,
      schemaVersion: PLAN_SCHEMA_VERSION,
    },
  }, { merge: true });

  return { success: true };
});
