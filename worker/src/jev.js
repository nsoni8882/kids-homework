/* TypeSafe Jev: the semantic judgments this app cannot make with string rules.
 *
 * Jev returns typed answers with probabilities rather than text, so code owns
 * every decision. Nothing here lets the model decide a mark on its own: it
 * produces a probability and a credit score, and the POLICY constants below
 * turn those into an outcome or a referral to the parent.
 *
 * The key is a Worker secret and never reaches a browser.
 */

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-latest';

/* Policy, tuned against the labelled cases in scripts/jev-calibrate.mjs.
   The middle band is deliberately wide: an uncertain answer is worth a parent's
   ten seconds, and getting a mark wrong in either direction is worse than asking. */
export const POLICY = {
  autoCorrect: 0.90,       // noul at or above this, and confident, marks it right
  autoWrong: 0.10,         // noul at or below this marks it wrong
  minConfidence: 0.80,     // below this the credit score is not trusted on its own
  qualityConcern: 0.60,    // default bar for raising a question-quality flag
};

/* Per check thresholds, calibrated against scripts/jev-calibrate.mjs rather than
   guessed. A wrong key is cheap to look at and expensive to miss, so it is set
   low. Ambiguity judgments spread probability across several fair readings, so
   they need a higher bar before they are worth your time. */
export const THRESHOLDS = {
  scheme_unclear: 0.70,
  off_slot_section: 0.70,
  no_evidence: 0.70,
  key_wrong: 0.60,
  parity_shortcut: 0.55,
  hinted: 0.60,
  ambiguous: 0.72,
  answers_too_narrow: 0.70,
  too_hard: 0.65,
};

export class Jev {
  constructor(apiKey, { fetchImpl = fetch } = {}) {
    if (!apiKey) throw new Error('Jev needs an API key');
    this.apiKey = apiKey;
    // Bound to the global. Calling this.fetch(...) would pass the Jev instance
    // as `this`, which a Worker rejects with "Illegal invocation". Node is
    // lenient about it, so this only shows up once it is deployed.
    this.fetch = fetchImpl.bind(globalThis);
    this.usage = { requests: 0, inputTokens: 0 };
  }

  /** One request, many independent questions. They run in parallel and cannot
      see each other's answers, so every premise must be stated in its own. */
  async ask(state, questions, { timeoutMs = 12000, attempts = 3 } = {}) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await this.fetch(ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model: MODEL, state, questions }),
          signal: ctrl.signal,
        });
        clearTimeout(timer);

        if (res.status === 429 || res.status === 529 || res.status >= 500) {
          throw new Error(`Jev transient ${res.status}`);
        }
        if (!res.ok) {
          // A rejected key or a malformed request will be rejected identically
          // three times over, so retrying only delays the referral to the
          // parent by the length of the backoff. Fail now.
          const err = new Error(`Jev ${res.status}: ${(await res.text()).slice(0, 200)}`);
          err.permanent = true;
          throw err;
        }
        const body = await res.json();
        if (!body || !body.answers) throw new Error('Jev returned no answers');
        this.usage.requests++;
        this.usage.inputTokens += (body.usage && body.usage.input_tokens) || 0;
        return body.answers;
      } catch (err) {
        clearTimeout(timer);
        lastError = err;
        if (err.permanent) break;
        if (attempt < attempts) {
          await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
        }
      }
    }
    throw lastError;
  }
}

/** Read one judgment out of a Jev reply, rather than trusting the key is there.
    A missing key used to surface as "cannot read noul of undefined", which is a
    500 on the submit rather than the referral to the parent it should be. */
function need(answers, key, field) {
  const a = answers && answers[key];
  if (!a || typeof a[field] !== 'number') {
    throw new Error(`Jev did not answer ${key}.${field}`);
  }
  return a[field];
}

/* ------------------------------------------------------------------ marking */

const AGE = { mason: 9, elysia: 7 };

/**
 * Mark one written answer semantically.
 *
 * Returns { outcome, marks, confidence, reason } where outcome is
 * 'correct' | 'wrong' | 'refer'. 'refer' means a human decides, and it is a
 * perfectly good outcome rather than a failure.
 */
export async function markAnswer(jev, { child, question, given }) {
  const marks = question.marks || 1;

  const state = {
    question: question.text,
    markScheme: question.markScheme || null,
    acceptedAnswers: question.accepted || null,
    childAnswer: given || '',
    childAge: AGE[child] || 8,
  };

  const essentiallyCorrect = {
    type: 'noul',
    instructions:
      'Does `childAnswer` give the essential idea that `markScheme` and `acceptedAnswers` '
      + 'require? Judge the meaning, not the wording. Ignore spelling, punctuation, '
      + 'capitalisation and grammar: the child is `childAge` years old and is typing. '
      + 'An answer that states the opposite, or that denies the required idea, is not correct.',
    criteria: {
      true: 'Conveys what the mark scheme requires, however it is phrased or spelled',
      false: 'Misses the required idea, states something different or opposite, or is blank',
    },
  };

  // A one mark question is a yes or no, so the probability alone decides it and
  // the credit score is never read. Asking for it anyway doubled the judgments
  // on the commonest case for nothing.
  if (marks === 1) {
    const answers = await jev.ask(state, { essentially_correct: essentiallyCorrect });
    const noul = need(answers, 'essentially_correct', 'noul');
    if (noul >= POLICY.autoCorrect) {
      return { outcome: 'correct', marks: 1, confidence: noul, reason: `jev ${noul.toFixed(2)}` };
    }
    if (noul <= POLICY.autoWrong) {
      return { outcome: 'wrong', marks: 0, confidence: 1 - noul, reason: `jev ${noul.toFixed(2)}` };
    }
    return { outcome: 'refer', marks: null, confidence: noul, reason: `uncertain, jev ${noul.toFixed(2)}` };
  }

  const answers = await jev.ask(state, {
    essentially_correct: essentiallyCorrect,
    credit: {
      type: 'score',
      instructions:
        `How much credit does \`childAnswer\` deserve against \`markScheme\`, out of ${marks} `
        + 'mark(s)? Award for content, never for presentation.',
      criteria: creditLevels(marks, question),
    },
  });

  const credit = need(answers, 'credit', 'score');
  const confidence = need(answers, 'credit', 'confidence');
  const rounded = Math.max(0, Math.min(marks, Math.round(credit)));

  // Multi mark questions need the credit score, and it has to be a confident one.
  if (confidence >= POLICY.minConfidence) {
    return {
      outcome: rounded === 0 ? 'wrong' : 'correct',
      marks: rounded,
      confidence,
      reason: `jev credit ${credit.toFixed(2)} of ${marks}, confidence ${confidence.toFixed(2)}`,
    };
  }
  return {
    outcome: 'refer',
    marks: null,
    confidence,
    reason: `credit ${credit.toFixed(2)} but confidence only ${confidence.toFixed(2)}`,
  };
}

function creditLevels(marks, question) {
  if (marks === 1) {
    return ['Wrong, blank or off topic', 'Correct in substance'];
  }
  if (marks === 2) {
    return [
      'No creditable content: blank, off topic, or wrong',
      'Partly right: one required element given, or the right idea with a clear omission',
      'Fully right: every element the mark scheme requires is present',
    ];
  }
  const out = ['No creditable content: blank, off topic, or wrong'];
  for (let i = 1; i < marks; i++) {
    out.push(`${i} of the ${marks} required elements given correctly`);
  }
  out.push(`All ${marks} required elements given correctly`);
  if (question.markScheme) out[out.length - 1] += '. See the mark scheme for what counts.';
  return out;
}

/* --------------------------------------------------- diagnosing a wrong answer */

/* Choice criteria is a map of option name to description, not a list. */
const ERROR_KINDS = {
  misread: 'Misread or misunderstood what the question asked for',
  slip: 'Knew the method but made an arithmetic or copying slip',
  wrong_method: 'Used the wrong method or operation',
  incomplete: 'Answered only part of what was asked',
  spelling: 'Spelling or typing error in an otherwise correct answer',
  blank: 'Left it blank or ran out of time',
  bad_question: 'The question itself is unclear or has more than one defensible answer',
};

/** Why did this one go wrong? Feeds the gap tracker so the weekly diagnosis
    starts from evidence rather than a guess. */
export async function diagnose(jev, { child, question, given, expected }) {
  const answers = await jev.ask(
    {
      question: question.text,
      expectedAnswer: expected,
      childAnswer: given || '',
      childAge: AGE[child] || 8,
      subject: question.subject || null,
    },
    {
      error_kind: {
        type: 'choice',
        instructions:
          'The child answered this incorrectly. Which single description best explains why, '
          + 'judging only from `childAnswer` against `expectedAnswer`?',
        criteria: ERROR_KINDS,
      },
      question_is_flawed: {
        type: 'noul',
        instructions:
          'Setting the child aside, is this question itself flawed? It is flawed if it is '
          + 'ambiguous, if more than one answer is defensible, if `expectedAnswer` is wrong, '
          + 'or if the wording invites the answer the child gave.',
        criteria: {
          true: 'The question or its expected answer is at fault',
          false: 'The question is sound and the child simply got it wrong',
        },
      },
    },
  );
  const kind = answers.error_kind && answers.error_kind.choice;
  if (!kind) throw new Error('Jev did not answer error_kind.choice');
  return {
    kind,
    kindLabel: ERROR_KINDS[kind] || 'unknown',
    kindConfidence: answers.error_kind.confidence,
    kindProbabilities: answers.error_kind.probabilities,
    questionFlawed: need(answers, 'question_is_flawed', 'noul'),
  };
}

/* ------------------------------------------------- the question quality gate */

/**
 * Run BEFORE a week goes out. These are the hard limits in curriculum/spine.json
 * marked "check: manual", which no string rule can test. Catching an ambiguous
 * odd-one-out before the child sits it is worth far more than arguing about the
 * mark afterwards.
 */
export async function checkQuestion(jev, { child, section, question, spineSlot, rung }) {
  const numeric = /^[\s\d,.:+\u00d7x*\u00f7/=?_-]+$/.test(question.text.replace(/odd one out/i, ''))
    || (question.accepted || []).every((a) => /^-?[\d.,]+$/.test(String(a)));

  const state = {
    sectionPurpose: spineSlot ? spineSlot.purpose : section.title,
    sectionRule: spineSlot ? spineSlot.fixed : null,
    // The level the child is actually working at. Without this the model has
    // only the slot's purpose, which says nothing about difficulty.
    currentSkill: rung ? rung.skill : null,
    // The method a question states on purpose, such as "shift back 5", is the
    // task, not a hint. Only a section testing a rule the child must INFER can
    // be spoiled by its passage.
    ruleMustBeInferred: !!(spineSlot && spineSlot.inferredRule),
    passage: section.passage || null,
    question: question.text,
    acceptedAnswers: question.accepted || null,
    markScheme: question.markScheme || null,
    childAge: AGE[child] || 8,
  };

  const hasKey = !!(question.accepted && question.accepted.length);

  const questions = {};
  if (hasKey) {
    questions.ambiguous = {
      type: 'noul',
      instructions:
        'Is there a second answer to this question that is defensible AND is NOT already listed '
        + 'in `acceptedAnswers`? An alternative that is already accepted does not count, nor does '
        + 'a merely worse answer. Only say true if a careful child could justify a different '
        + 'answer that would be marked wrong.',
      criteria: {
        true: 'A defensible answer exists that is missing from acceptedAnswers, so a correct child would be marked wrong',
        false: 'Every defensible answer is already in acceptedAnswers',
      },
    };
    questions.key_wrong = {
      type: 'noul',
      instructions:
        'Is the first entry of `acceptedAnswers` actually WRONG? Check it against `passage` '
        + 'where there is one, and by arithmetic or plain fact where there is not. Work the '
        + 'answer out yourself before judging.',
      criteria: {
        true: 'The expected answer is incorrect',
        false: 'The expected answer is correct',
      },
    };
    questions.answers_too_narrow = {
      type: 'noul',
      instructions:
        'Would a child who fully understands be marked WRONG because `acceptedAnswers` omits an '
        + 'obvious correct phrasing? Spelling, capitalisation, spacing, surrounding filler words '
        + 'and a trailing unit are all tolerated elsewhere, so they do NOT count here. Only a '
        + 'genuinely different wording or a different correct value counts.',
      criteria: {
        true: 'A clearly correct and differently worded answer is missing from acceptedAnswers',
        false: 'The accepted list covers the reasonable phrasings',
      },
    };
  }

  questions.too_hard = {
      type: 'noul',
      instructions:
        'Is this question clearly beyond a `childAge` year old whose current level is '
        + '`currentSkill`? Judge it against that skill, not against the topic in general. A '
        + 'question needing a method well past `currentSkill`, or several methods at once, is '
        + 'too hard. Being merely challenging within the skill is fine: this is practice for a '
        + 'selective entrance test.',
      criteria: {
        true: 'Needs a method or vocabulary well beyond currentSkill, or far too many steps for the age',
        false: 'Within reach of currentSkill, or a fair stretch beyond it',
      },
  };

  // A question the parent marks is judged on its mark scheme, not on a key it
  // does not have.
  if (!hasKey && question.markScheme) {
    questions.scheme_unclear = {
      type: 'noul',
      instructions:
        'Is `markScheme` too vague for a parent to mark `question` consistently? It should say '
        + 'what earns each mark.',
      criteria: {
        true: 'A parent could not tell from the mark scheme what earns the marks',
        false: 'The mark scheme states what earns the marks',
      },
    };
  }

  // Only ask about hinting where the rule is supposed to be inferred. Asking it
  // of a cipher, where the shift is deliberately given, produced nothing but noise.
  // A section that already declares itself hinted is a known, deliberate choice.
  if (state.ruleMustBeInferred && section.passage && !section.hinted) {
    questions.hinted = {
      type: 'noul',
      instructions:
        'Does `passage` state the rule or principle that this question is meant to make the '
        + 'child work out for themselves? If it does, a correct answer proves only that the '
        + 'child can copy.',
      criteria: {
        true: 'The passage states the very rule the question tests',
        false: 'The child must work the rule out',
      },
    };
  }

  // Parity is only an unintended shortcut when the items are numbers. On a word
  // set the discriminating property IS the intended rule.
  if (numeric && /odd one out/i.test(question.text + ' ' + section.title)) {
    questions.parity_shortcut = {
      type: 'noul',
      instructions:
        'In this number set, is exactly one number odd while the rest are even, or exactly one '
        + 'even while the rest are odd? If so a child can answer by parity alone. Say true ONLY '
        + 'if that parity answer differs from `acceptedAnswers`, because then two different '
        + 'answers are each defensible.',
      criteria: {
        true: 'One number stands out by odd or even, and it is not the accepted answer',
        false: 'Parity does not single out a number, or it singles out the accepted one',
      },
    };
  }

  const answers = await jev.ask(state, questions);

  const LABELS = {
    ambiguous: 'a defensible answer is missing from the key',
    key_wrong: 'the expected answer looks wrong',
    hinted: 'the passage gives the rule away',
    too_hard: 'above the child\u2019s level',
    answers_too_narrow: 'accepted answers look too narrow',
    parity_shortcut: 'a second answer is defensible by odd or even',
    scheme_unclear: 'the mark scheme is too vague to mark consistently',
  };

  const flags = [];
  for (const key of Object.keys(questions)) {
    const p = need(answers, key, 'noul');
    const threshold = THRESHOLDS[key] ?? POLICY.qualityConcern;
    if (p >= threshold) flags.push({ key, label: LABELS[key], probability: p, threshold });
  }
  flags.sort((a, b) => b.probability - a.probability);
  return { questionId: question.id, flags, clean: flags.length === 0, raw: answers };
}

/**
 * Whether a SECTION as a whole exercises the rung it is supposed to.
 *
 * This is deliberately a section level question. A section contains a range of
 * items by design, with easier ones early, so asking it of each question in turn
 * flags most of a sound paper. What matters is whether the section, taken
 * together, actually tests the rung the child is on.
 */
export async function checkSection(jev, { child, section, spineSlot, rung }) {
  if (!rung) return { sectionId: section.id, flags: [], clean: true };

  const answers = await jev.ask(
    {
      sectionTitle: section.title,
      sectionPurpose: spineSlot ? spineSlot.purpose : section.title,
      sectionRule: spineSlot ? spineSlot.fixed : null,
      currentSkill: rung.skill,
      rungGoal: rung.advanceWhen,
      childAge: AGE[child] || 8,
      questions: section.questions
        .filter((q) => q.inputType !== 'none')
        .slice(0, 12)
        .map((q) => q.text),
    },
    {
      off_slot: {
        type: 'noul',
        instructions:
          'Taken as a whole, do `questions` exercise `currentSkill`? Some easier warm up items '
          + 'are expected and fine. Say true only if the section as a whole tests a DIFFERENT '
          + 'skill, so its result would say nothing about whether the child has mastered '
          + '`currentSkill`.',
        criteria: {
          true: 'The section as a whole tests a different skill, so it cannot evidence this rung',
          false: 'The section exercises the current skill, whatever the spread of difficulty',
        },
      },
      no_evidence: {
        type: 'noul',
        instructions:
          'Could this section produce the evidence `rungGoal` asks for? It cannot if no question '
          + 'is demanding enough to show mastery of `currentSkill`.',
        criteria: {
          true: 'Every question is below the level, so a full score would not prove the rung',
          false: 'At least one question genuinely tests the skill',
        },
      },
    },
  );

  const LABELS = {
    off_slot: 'this section does not test the rung the child is on',
    no_evidence: 'nothing here is demanding enough to evidence the rung',
  };
  const flags = [];
  for (const key of ['off_slot', 'no_evidence']) {
    const p = need(answers, key, 'noul');
    const t = THRESHOLDS[key === 'off_slot' ? 'off_slot_section' : 'no_evidence'] ?? 0.70;
    if (p >= t) flags.push({ key, label: LABELS[key], probability: p, threshold: t });
  }
  return { sectionId: section.id, flags, clean: flags.length === 0, raw: answers };
}

/* ------------------------------------------------------------ writing rubric */

const RUBRIC = {
  ideas: [
    'Off the prompt, or too little to judge',
    'On the prompt but thin: one idea, little detail',
    'Several relevant ideas with some detail',
    'Ideas are developed and show imagination or insight',
  ],
  structure: [
    'No clear order',
    'A beginning and an end, but the middle wanders',
    'Clear beginning, middle and end, mostly in paragraphs',
    'Deliberately shaped, with paragraphs that each do a job',
  ],
  vocabulary: [
    'Very simple and repetitive word choice',
    'Simple but correct, occasional good word',
    'Varied, with some well chosen words',
    'Precise and varied, words chosen for effect',
  ],
  accuracy: [
    'Errors make it hard to read',
    'Frequent errors but still readable',
    'Mostly accurate sentences, punctuation and spelling',
    'Accurate throughout, including more ambitious sentences',
  ],
};

/** Score a piece of writing out of 10, with written feedback for the child.
    The parent always confirms: this returns a proposal, not a final mark. */
export async function scoreWriting(jev, { child, prompt, genre, text }) {
  const state = {
    prompt,
    genre: genre || 'narrative',
    writing: text,
    childAge: AGE[child] || 8,
    wordCount: (text || '').trim().split(/\s+/).filter(Boolean).length,
  };

  const questions = {};
  for (const [dim, criteria] of Object.entries(RUBRIC)) {
    questions[dim] = {
      type: 'score',
      instructions:
        `Judge \`writing\` on ${dim} against \`prompt\` and \`genre\`. Judge it as the work of a `
        + '`childAge` year old, not against an adult standard. Consider only this dimension.',
      criteria,
    };
  }
  questions.off_prompt = {
    type: 'noul',
    instructions: 'Does `writing` ignore `prompt` and write about something else entirely?',
    criteria: { true: 'It does not address the prompt', false: 'It addresses the prompt' },
  };

  const answers = await jev.ask(state, questions);

  const dims = {};
  let confidence = 1;
  for (const dim of Object.keys(RUBRIC)) {
    // 0..3 on the rubric, reported out of 2.5 so the four dimensions total 10
    dims[dim] = Math.round((need(answers, dim, 'score') / 3) * 2.5 * 2) / 2;
    confidence = Math.min(confidence, need(answers, dim, 'confidence'));
  }
  const total = Math.round(Object.values(dims).reduce((a, b) => a + b, 0) * 2) / 2;

  return {
    dims,
    total,
    confidence,
    offPrompt: need(answers, 'off_prompt', 'noul'),
    needsParent: confidence < POLICY.minConfidence
      || need(answers, 'off_prompt', 'noul') > POLICY.qualityConcern,
  };
}
