const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const Anthropic = require('@anthropic-ai/sdk');

admin.initializeApp();
setGlobalOptions({ region: 'us-central1' });

const PLAN_SCHEMA_VERSION = 1;

// ── Prompt builder ──────────────────────────────────────────────────────────

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

  const suppLabel = inputs.supplementsInclude === 'no'
    ? 'none requested'
    : inputs.supplements.length
      ? inputs.supplements.join(', ')
      : 'open to evidence-based recommendations';

  return `You are a certified nutritionist and personal trainer. Generate a complete, personalized ${inputs.timeline}-week nutrition and training plan optimized for ${goalLabel}.

USER PROFILE:
- Primary goal: ${goalLabel}
- Current weight: ${inputs.currentWeight} ${inputs.weightUnit}
- Goal weight: ${inputs.goalWeight} ${inputs.weightUnit}
- Current body fat: ${inputs.currentBf ? inputs.currentBf + '%' : 'not provided'}
- Diet type: ${dietLabel}
- Diet notes: ${inputs.dietNotes || 'none'}
- Food allergies/restrictions: ${inputs.allergies.length ? inputs.allergies.join(', ') : 'none'}
- Additional restrictions: ${inputs.allergyNotes || 'none'}
- Cooking comfort level: ${cookingLabel}
- Training days per week: ${inputs.trainingDaysPerWeek}
- Preferred training days: ${inputs.trainingDays.map(d => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d]).join(', ')}
- Primary training type: ${inputs.trainingType}
- Equipment available: ${inputs.equipment.length ? inputs.equipment.join(', ') : 'not specified'}
- Supplements: ${suppLabel}
- Supplement notes: ${inputs.supplementNotes || 'none'}

INSTRUCTIONS:
1. Calculate appropriate daily calorie and macro targets (protein, carbs, fat) based on the user's current weight, goal weight, timeline, and goal type.
2. Training days should be the user's preferred days. Rest days use lower calories/carbs.
3. Design a practical weekly meal rotation that strictly respects the diet type and restrictions.
4. If cooking level is minimal, prioritize no-cook and quick-assemble meals; skip or minimize batch prep.
5. If moderate or full, include batch prep sessions (Sunday and/or Thursday).
6. Write complete, real recipes for all cooked meals (not just meal names).
7. Shopping list should cover exactly one week of the plan.
8. All meals must hit macro targets reasonably closely.

Return ONLY a raw JSON object — no markdown, no explanation, no code fences. The JSON must exactly match this structure:

{
  "weeklyPlan": {
    "0": { "type": "training|rest", "meals": [{ "time": "str", "name": "str", "desc": "str", "cal": num, "p": num, "c": num, "f": num }] },
    "1": { "type": "training|rest", "meals": [...] },
    "2": { "type": "training|rest", "meals": [...] },
    "3": { "type": "training|rest", "meals": [...] },
    "4": { "type": "training|rest", "meals": [...] },
    "5": { "type": "training|rest", "meals": [...] },
    "6": { "type": "training|rest", "meals": [...] }
  },
  "macroTargets": {
    "training": { "cal": num, "p": num, "c": num, "f": num },
    "rest": { "cal": num, "p": num, "c": num, "f": num }
  },
  "recipes": [
    {
      "name": "str",
      "cat": "Batch Cook|Quick Prep|Salads & Bowls|No Cook",
      "prep": "str (e.g. 5 min)",
      "cook": "str (e.g. 20 min)",
      "serves": num,
      "macros": { "cal": num, "p": num, "c": num, "f": num },
      "ingredients": ["str"],
      "steps": ["str"]
    }
  ],
  "prepPlan": {
    "sun": { "label": "str (e.g. Covers Mon–Thu)", "items": [{ "id": "s1", "name": "str", "note": "str", "time": "str" }] },
    "thu": { "label": "str", "items": [{ "id": "t1", "name": "str", "note": "str", "time": "str" }] }
  },
  "shoppingList": [
    { "cat": "str (e.g. Proteins)", "items": [{ "id": "sh1", "name": "str", "qty": "str" }] }
  ],
  "supplements": ["str (e.g. Creatine — 5g/day with water, timing flexible)"],
  "notes": "str (1–2 sentences summarising the plan approach)"
}

Day numbering: 0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday.
If cooking level is minimal, prepPlan items arrays may be empty but the keys must still exist.
Every meal object must have all six fields: time, name, desc, cal, p, c, f.`;
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
