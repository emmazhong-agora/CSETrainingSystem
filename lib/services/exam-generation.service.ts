/**
 * Exam Generation Service
 * AI-powered question generation using XML knowledge context
 */

import prisma from '@/lib/prisma';
import {
  ExamQuestionType,
  DifficultyLevel,
  AIPromptUseCase,
} from '@prisma/client';
import { log } from '@/lib/logger';
import { ExamService } from '@/lib/services/exam.service';
import { KnowledgeContextService } from '@/lib/services/knowledge-context.service';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import s3Client, { ASSET_S3_BUCKET_NAME } from '@/lib/aws-s3';
import { createHash } from 'crypto';
import { AIPromptResolverService, type ResolvedAIPrompt } from '@/lib/services/ai-prompt-resolver.service';
import { createLLMChatCompletion } from '@/lib/services/llm-chat-client';
import { getPrimaryAiTranscriptTrack } from '@/lib/transcript-tracks';
import {
  buildEssayGradingCriteria,
  buildEssayRubricFromCriteria,
  buildEssaySampleAnswerGuidance,
  type EssayGradingCriterion,
  type EssayScoringStyle,
} from '@/lib/essay-grading';

export interface GenerationConfig {
  questionCounts: {
    singleChoice?: number;
    multipleChoice?: number;
    trueFalse?: number;
    fillInBlank?: number;
    essay?: number;
  };
  difficulty: DifficultyLevel | 'mixed';
  choiceOptionCount?: 4 | 5 | 6;
  lessonIds?: string[];
  topics?: string[];
  focusAreas?: string[];
  generateEssayScoringCriteria?: boolean;
  essayScoringStyle?: EssayScoringStyle;
}

export interface GeneratedQuestion {
  type: ExamQuestionType;
  difficulty: DifficultyLevel;
  question: string;
  options?: string[];
  correctAnswer?: string;
  rubric?: string;
  sampleAnswer?: string;
  gradingCriteria?: EssayGradingCriterion[];
  explanation?: string;
  topic?: string;
  sourceChunkIds: string[];
  confidence: number;
}

export interface GenerationResult {
  questions: GeneratedQuestion[];
  createdQuestions: Array<{ type: ExamQuestionType }>;
  totalGenerated: number;
  tokensUsed: number;
  warnings: string[];
}

type CoverageTopic = {
  title: string;
  anchorType?: string;
  timestamp?: string;
};

type QuestionCoverageHints = {
  questionIndex: number;
  totalQuestions: number;
  preferredTopics: string[];
  alreadyCoveredTopics: string[];
  avoidTopics: string[];
  recentQuestionStems: string[];
};

export class ExamGenerationService {
  private knowledgeService: KnowledgeContextService;

  constructor() {
    this.knowledgeService = new KnowledgeContextService();
  }

  private normalizeChoiceOptionCount(value: number | undefined): 4 | 5 | 6 {
    return value === 5 || value === 6 ? value : 4;
  }

  private buildPlaceholderOptions(optionCount: number): string[] {
    return Array.from({ length: optionCount }, (_, index) => `Option ${String.fromCharCode(65 + index)}`);
  }

  private augmentEssayQuestion(question: GeneratedQuestion, config: GenerationConfig): GeneratedQuestion {
    if (question.type !== ExamQuestionType.ESSAY) return question;
    if (config.generateEssayScoringCriteria === false && question.gradingCriteria?.length) {
      return question;
    }

    const criteria =
      question.gradingCriteria && question.gradingCriteria.length > 0
        ? question.gradingCriteria
        : config.generateEssayScoringCriteria === false
          ? []
          : buildEssayGradingCriteria({
              maxPoints: 10,
              style: config.essayScoringStyle,
              question: question.question,
              rubric: question.rubric,
            });

    return {
      ...question,
      rubric:
        question.rubric?.trim() ||
        (criteria.length > 0 ? buildEssayRubricFromCriteria(criteria) : question.rubric),
      sampleAnswer:
        question.sampleAnswer?.trim() ||
        (criteria.length > 0
          ? buildEssaySampleAnswerGuidance({
              question: question.question,
              rubric: question.rubric,
              criteria,
            })
          : question.sampleAnswer),
      gradingCriteria: criteria.length > 0 ? criteria : question.gradingCriteria,
    };
  }

  /**
   * Generate questions for an exam based on XML knowledge context.
   * For exams linked to a course, this uses lesson knowledge contexts generated from VTT → XML.
   */
  async generateQuestions(
    examId: string,
    config: GenerationConfig
  ): Promise<GenerationResult> {
    const exam = await prisma.exam.findUnique({
      where: { id: examId },
      include: {
        materials: {
          where: { status: 'READY' },
          include: {
            chunks: true,
          },
        },
        course: {
          include: {
            chapters: {
              orderBy: { order: 'asc' },
              include: {
                lessons: {
                  orderBy: { order: 'asc' },
                  include: {
                    knowledgeContext: true,
                    knowledgeAnchors: {
                      orderBy: { sequenceIndex: 'asc' },
                    },
                    transcripts: {
                      where: {
                        isActive: true,
                        archivedAt: null,
                      },
                      orderBy: [{ isPrimaryForAI: 'desc' }, { isDefaultSubtitle: 'desc' }, { createdAt: 'asc' }],
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!exam) {
      throw new Error('EXAM_NOT_FOUND');
    }

    const promptConfig = await AIPromptResolverService.resolve({
      useCase: AIPromptUseCase.EXAM_GENERATION,
      courseId: exam.courseId ?? null,
      examId: exam.id,
    });

    const questions: GeneratedQuestion[] = [];
    const createdQuestions: Array<{ type: ExamQuestionType }> = [];
    const warnings: string[] = [];
    let totalTokensUsed = 0;

    // Normalize counts (defensive: coerce to number to avoid unexpected truthiness)
    const counts = {
      singleChoice: Number(config.questionCounts.singleChoice || 0),
      multipleChoice: Number(config.questionCounts.multipleChoice || 0),
      trueFalse: Number(config.questionCounts.trueFalse || 0),
      fillInBlank: Number(config.questionCounts.fillInBlank || 0),
      essay: Number(config.questionCounts.essay || 0),
    };

    // Plan list to iterate deterministically
    const typePlan: Array<{ key: keyof typeof counts; count: number }> = [
      { key: 'singleChoice', count: counts.singleChoice },
      { key: 'multipleChoice', count: counts.multipleChoice },
      { key: 'trueFalse', count: counts.trueFalse },
      { key: 'fillInBlank', count: counts.fillInBlank },
      { key: 'essay', count: counts.essay },
    ];

    const toQuestionType = (key: keyof typeof counts): ExamQuestionType => {
      switch (key) {
        case 'singleChoice':
          return ExamQuestionType.SINGLE_CHOICE;
        case 'multipleChoice':
          return ExamQuestionType.MULTIPLE_CHOICE;
        case 'trueFalse':
          return ExamQuestionType.TRUE_FALSE;
        case 'fillInBlank':
          return ExamQuestionType.FILL_IN_BLANK;
        case 'essay':
          return ExamQuestionType.ESSAY;
        default:
          return ExamQuestionType.MULTIPLE_CHOICE;
      }
    };

    const shuffleInPlace = <T,>(items: T[]): T[] => {
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
      }
      return items;
    };

    const questionJobs: Array<{ key: keyof typeof counts; type: ExamQuestionType; index: number }> = [];
    for (const plan of typePlan) {
      if (!plan.count || plan.count <= 0) continue;
      for (let i = 0; i < plan.count; i++) {
        questionJobs.push({ key: plan.key, type: toQuestionType(plan.key), index: i + 1 });
      }
    }
    shuffleInPlace(questionJobs);

    // Build a stable knowledge prefix so repeated calls benefit from OpenAI context caching.
    const knowledgePrefix = await this.buildKnowledgePrefixOrThrow(exam, config.lessonIds);

    const coverageTopics = this.extractCoverageTopicsFromKnowledgePrefix(knowledgePrefix);
    const coveredTopicKeys = new Set<string>();
    const coveredTopicTitles: string[] = [];

    for (let i = 0; i < questionJobs.length; i++) {
      const job = questionJobs[i];
      const difficulty = config.difficulty === 'mixed'
        ? this.getRandomDifficulty()
        : config.difficulty;

      const preferredTopics = this.selectPreferredCoverageTopics(
        coverageTopics,
        coveredTopicKeys,
        config.topics,
        config.focusAreas
      );
      const coverageHints: QuestionCoverageHints = {
        questionIndex: i + 1,
        totalQuestions: questionJobs.length,
        preferredTopics,
        alreadyCoveredTopics: coveredTopicTitles.slice(-12),
        avoidTopics: coveredTopicTitles.slice(-8),
        recentQuestionStems: questions.slice(-4).map((q) => q.question),
      };

      try {
        const result = await this.generateSingleQuestion(
          job.type,
          difficulty,
          knowledgePrefix,
          config.topics,
          config.focusAreas,
          promptConfig,
          coverageHints,
          config.choiceOptionCount
        );

        const resolvedQuestion = this.augmentEssayQuestion(result.question, config);
        questions.push(resolvedQuestion);
        totalTokensUsed += result.tokensUsed;

        this.trackCoveredTopic(
          coveredTopicKeys,
          coveredTopicTitles,
          coverageTopics,
          result.question.topic,
          preferredTopics[0]
        );

        const created = await ExamService.addQuestion(examId, {
          type: job.type,
          difficulty: resolvedQuestion.difficulty,
          question: resolvedQuestion.question,
          options: resolvedQuestion.options,
          correctAnswer: resolvedQuestion.correctAnswer,
          rubric: resolvedQuestion.rubric,
          sampleAnswer: resolvedQuestion.sampleAnswer,
          gradingCriteria: resolvedQuestion.gradingCriteria,
          explanation: resolvedQuestion.explanation,
          topic: resolvedQuestion.topic,
          isAIGenerated: true,
          aiModel: 'gpt-4o-mini',
          generationPrompt: result.generationPrompt,
        });
        createdQuestions.push(created);
      } catch (error) {
        console.error(`Failed to generate ${job.key} question:`, error);
        warnings.push(`Failed to generate ${job.key} question ${job.index}: ${error instanceof Error ? error.message : 'Unknown error'}`);

        this.trackCoveredTopic(
          coveredTopicKeys,
          coveredTopicTitles,
          coverageTopics,
          undefined,
          preferredTopics[0]
        );

        // Fallback: generate a placeholder question so the request still yields output.
        const fallback = this.augmentEssayQuestion(
          this.buildFallbackQuestion(job.type, difficulty, config.choiceOptionCount),
          config
        );
        const created = await ExamService.addQuestion(examId, {
          type: job.type,
          difficulty: fallback.difficulty,
          question: fallback.question,
          options: fallback.options,
          correctAnswer: fallback.correctAnswer,
          rubric: fallback.rubric,
          sampleAnswer: fallback.sampleAnswer,
          gradingCriteria: fallback.gradingCriteria,
          explanation: fallback.explanation,
          topic: fallback.topic,
          isAIGenerated: true,
          aiModel: 'fallback',
          generationPrompt: 'fallback',
        });
        createdQuestions.push(created);
      }
    }

    // Update exam's AI generation config
    await prisma.exam.update({
      where: { id: examId },
      data: {
        aiGenerationConfig: config as any,
      },
    });

    // Safety net: ensure we fulfilled the requested counts per type. If any type is under-produced,
    // create deterministic fallback questions so the caller always receives the requested total.
    const createdByType = createdQuestions.reduce<Partial<Record<ExamQuestionType, number>>>((acc, q) => {
      acc[q.type] = (acc[q.type] ?? 0) + 1;
      return acc;
    }, {});
    for (const plan of typePlan) {
      const { key, count } = plan;
      if (!count || count <= 0) continue;
      const questionType =
        key === 'singleChoice'
          ? ExamQuestionType.SINGLE_CHOICE
          : key === 'multipleChoice'
            ? ExamQuestionType.MULTIPLE_CHOICE
            : key === 'trueFalse'
              ? ExamQuestionType.TRUE_FALSE
              : key === 'fillInBlank'
                ? ExamQuestionType.FILL_IN_BLANK
                : key === 'essay'
                  ? ExamQuestionType.ESSAY
                  : ExamQuestionType.MULTIPLE_CHOICE; // default safety
      const have = createdByType[questionType] ?? 0;
      if (have >= count) continue;

      const needed = count - have;
      for (let i = 0; i < needed; i++) {
        const difficulty = config.difficulty === 'mixed'
          ? this.getRandomDifficulty()
          : config.difficulty as DifficultyLevel;
        const fallback = this.augmentEssayQuestion(
          this.buildFallbackQuestion(questionType, difficulty, config.choiceOptionCount),
          config
        );
        try {
          const created = await ExamService.addQuestion(examId, {
            type: fallback.type,
            difficulty: fallback.difficulty,
            question: fallback.question,
            options: fallback.options,
            correctAnswer: fallback.correctAnswer,
            rubric: fallback.rubric,
            sampleAnswer: fallback.sampleAnswer,
            gradingCriteria: fallback.gradingCriteria,
            explanation: fallback.explanation,
            topic: fallback.topic,
            isAIGenerated: true,
            aiModel: 'fallback',
            generationPrompt: 'fallback-under-produced',
          });
          createdQuestions.push(created);
        } catch (fallbackError) {
          console.error('Fallback question creation failed', {
            examId,
            questionType,
            error: fallbackError,
          });
          warnings.push(`Fallback creation failed for ${key}: ${fallbackError instanceof Error ? fallbackError.message : 'Unknown error'}`);
        }
      }
    }

    const createdAfterFallback = createdQuestions.reduce<Partial<Record<ExamQuestionType, number>>>((acc, q) => {
      acc[q.type] = (acc[q.type] ?? 0) + 1;
      return acc;
    }, {});
    return {
      questions,
      createdQuestions,
      totalGenerated: questions.length,
      tokensUsed: totalTokensUsed,
      warnings,
    };
  }

  /**
   * Build a stable XML knowledge prefix used for all generation calls.
   */
  private async buildKnowledgePrefixOrThrow(exam: any, lessonIds?: string[]): Promise<string> {
    const allowSet = Array.isArray(lessonIds) && lessonIds.length > 0 ? new Set(lessonIds) : null;

    // Course-linked exams: list from the course curriculum, optionally filtered by lessonIds.
    if (exam.course) {
      const course = exam.course;
      const lessons: Array<{
        id: string;
        title: string;
        description?: string | null;
        chapter: { title: string; order: number };
        order: number;
        course: { id: string; title: string };
        knowledgeContext: any | null;
        knowledgeAnchors: Array<{
          timestampStr: string;
          title: string;
          summary: string;
          keyTerms: string[];
          anchorType: string;
        }>;
        transcripts: Array<{ s3Key: string; filename: string }>;
      }> = [];

      for (const chapter of course.chapters ?? []) {
        for (const lesson of chapter.lessons ?? []) {
          if (allowSet && !allowSet.has(lesson.id)) continue;
          lessons.push({
            id: lesson.id,
            title: lesson.title,
            description: lesson.description,
            chapter: { title: chapter.title, order: chapter.order },
            order: lesson.order,
            course: { id: course.id, title: course.title },
            knowledgeContext: lesson.knowledgeContext ?? null,
            knowledgeAnchors: lesson.knowledgeAnchors ?? [],
            transcripts: lesson.transcripts ?? [],
          });
        }
      }

      if (lessons.length === 0) throw new Error('NO_CONTENT_AVAILABLE');

      return await this.buildBundleXml({
        bundleType: 'COURSE',
        bundleId: course.id,
        bundleTitle: course.title,
        lessons,
      });
    }

    // Unlinked exams: lessons must be selected explicitly and can span courses.
    if (!allowSet) throw new Error('NO_CONTENT_AVAILABLE');

    const selectedLessons = await prisma.lesson.findMany({
      where: { id: { in: Array.from(allowSet) } },
      include: {
        chapter: { include: { course: true } },
        knowledgeContext: true,
        knowledgeAnchors: { orderBy: { sequenceIndex: 'asc' } },
        transcripts: {
          where: {
            isActive: true,
            archivedAt: null,
          },
          orderBy: [{ isPrimaryForAI: 'desc' }, { isDefaultSubtitle: 'desc' }, { createdAt: 'asc' }],
        },
      },
    });

    const foundLessonIds = new Set(selectedLessons.map((lesson) => lesson.id));
    const missingLessonIds = Array.from(allowSet).filter((lessonId) => !foundLessonIds.has(lessonId));

    if (missingLessonIds.length > 0) {
      log('KnowledgeContext', 'warn', 'Standalone exam references missing lesson IDs', {
        examId: exam.id,
        requestedLessonIds: Array.from(allowSet),
        missingLessonIds,
      });
    }

    if (selectedLessons.length === 0) {
      if (missingLessonIds.length > 0) {
        throw new Error(`LESSONS_NOT_FOUND:${missingLessonIds.join(',')}`);
      }
      throw new Error('NO_CONTENT_AVAILABLE');
    }

    const lessons = selectedLessons.map((lesson) => ({
      id: lesson.id,
      title: lesson.title,
      description: lesson.description,
      chapter: { title: lesson.chapter.title, order: lesson.chapter.order },
      order: lesson.order,
      course: { id: lesson.chapter.course.id, title: lesson.chapter.course.title },
      knowledgeContext: lesson.knowledgeContext ?? null,
      knowledgeAnchors: lesson.knowledgeAnchors ?? [],
      transcripts: lesson.transcripts ?? [],
    }));

    return await this.buildBundleXml({
      bundleType: 'STANDALONE',
      bundleId: exam.id,
      bundleTitle: exam.title,
      lessons,
    });
  }

  private async buildBundleXml(input: {
    bundleType: 'COURSE' | 'STANDALONE';
    bundleId: string;
    bundleTitle: string;
    lessons: Array<{
      id: string;
      title: string;
      description?: string | null;
      chapter: { title: string; order: number };
      order: number;
      course: { id: string; title: string };
      knowledgeContext: any | null;
      knowledgeAnchors: Array<{
        timestampStr: string;
        title: string;
        summary: string;
        keyTerms: string[];
        anchorType: string;
      }>;
      transcripts: Array<{ s3Key: string; filename: string }>;
    }>;
  }): Promise<string> {
    // Deterministic ordering.
    const sorted = input.lessons.slice().sort((a, b) => {
      if (a.course.id !== b.course.id) return a.course.id.localeCompare(b.course.id);
      if (a.chapter.order !== b.chapter.order) return a.chapter.order - b.chapter.order;
      return a.order - b.order;
    });

    const maxChars = parseInt(process.env.EXAM_GENERATION_MAX_XML_CHARS || '160000', 10);
    const maxLessonChars = parseInt(process.env.EXAM_GENERATION_MAX_XML_CHARS_PER_LESSON || '60000', 10);

    let used = 0;
    const parts: string[] = [];
    const skippedLessons: Array<{ lessonId: string; title: string; reason: string }> = [];

    if (input.bundleType === 'COURSE') {
      parts.push(
        `COURSE_KNOWLEDGE_XML:\n<course_knowledge_context course_id="${this.escapeAttr(input.bundleId)}" course_title="${this.escapeAttr(input.bundleTitle)}" version="1.0">`
      );
    } else {
      parts.push(
        `EXAM_KNOWLEDGE_XML:\n<knowledge_context_bundle exam_id="${this.escapeAttr(input.bundleId)}" exam_title="${this.escapeAttr(input.bundleTitle)}" version="1.0">`
      );
    }

    for (const lesson of sorted) {
      let xml = await this.knowledgeService.getKnowledgeContext(lesson.id);
      let missingReason: string | null = null;

      if (!xml) {
        const transcript = getPrimaryAiTranscriptTrack(lesson.transcripts);
        if (transcript?.s3Key) {
          try {
            const command = new GetObjectCommand({ Bucket: ASSET_S3_BUCKET_NAME, Key: transcript.s3Key });
            const response = await s3Client.send(command);
            const vttContent = (await response.Body?.transformToString('utf-8')) || '';

            if (vttContent.trim()) {
              await this.knowledgeService.generateAndStoreContext(lesson.id, vttContent, {
                courseId: lesson.course.id,
                courseTitle: lesson.course.title,
                lessonId: lesson.id,
                lessonTitle: lesson.title,
                chapterTitle: lesson.chapter.title,
                lessonDescription: lesson.description || undefined,
              });
              xml = await this.knowledgeService.getKnowledgeContext(lesson.id);
            }
          } catch (error) {
            missingReason = 'TRANSCRIPT_REBUILD_FAILED';
            log('KnowledgeContext', 'warn', 'Failed to rebuild knowledge context during question generation', {
              lessonId: lesson.id,
              lessonTitle: lesson.title,
              transcriptKey: transcript.s3Key,
              error: error instanceof Error ? error.message : 'Unknown error',
            });
          }
        } else {
          missingReason = 'TRANSCRIPT_MISSING';
        }
      }

      if (!xml) {
        skippedLessons.push({
          lessonId: lesson.id,
          title: lesson.title,
          reason: missingReason ?? 'XML_UNAVAILABLE_AFTER_REBUILD',
        });
        continue;
      }

      const truncated = xml.length > maxLessonChars ? xml.slice(0, maxLessonChars) : xml;
      const wrapped = this.wrapCdata(truncated);
      const anchorsPreview = (lesson.knowledgeAnchors ?? []).slice(0, 12).map((a) => ({
        timestamp: a.timestampStr,
        type: a.anchorType,
        title: a.title,
        keyTerms: a.keyTerms?.slice(0, 6) ?? [],
      }));

      const attrs =
        input.bundleType === 'COURSE'
          ? `lesson_id="${lesson.id}" title="${this.escapeAttr(lesson.title)}" chapter="${this.escapeAttr(lesson.chapter.title)}"`
          : `lesson_id="${lesson.id}" title="${this.escapeAttr(lesson.title)}" course_id="${this.escapeAttr(lesson.course.id)}" course_title="${this.escapeAttr(lesson.course.title)}" chapter="${this.escapeAttr(lesson.chapter.title)}"`;

      const block = `\n  <lesson ${attrs}>\n    <anchor_index>${this.escapeText(JSON.stringify(anchorsPreview))}</anchor_index>\n    <knowledge_base><![CDATA[${wrapped}]]></knowledge_base>\n  </lesson>\n`;

      if (used + block.length > maxChars) break;
      parts.push(block);
      used += block.length;
    }

    parts.push(input.bundleType === 'COURSE' ? `</course_knowledge_context>\n` : `</knowledge_context_bundle>\n`);

    if (parts.length <= 2) {
      log('KnowledgeContext', 'warn', 'No usable knowledge context available for question generation', {
        bundleType: input.bundleType,
        bundleId: input.bundleId,
        bundleTitle: input.bundleTitle,
        requestedLessons: sorted.map((lesson) => ({
          lessonId: lesson.id,
          title: lesson.title,
          hasTranscript: Boolean(getPrimaryAiTranscriptTrack(lesson.transcripts)?.s3Key),
          knowledgeStatus: lesson.knowledgeContext?.status ?? 'MISSING',
        })),
        skippedLessons,
      });

      const detail = skippedLessons.map((item) => `${item.lessonId}:${item.reason}`).join(',');
      throw new Error(detail ? `NO_CONTENT_AVAILABLE:${detail}` : 'NO_CONTENT_AVAILABLE');
    }
    return parts.join('');
  }

  /**
   * Generate a single question
   */
  private async generateSingleQuestion(
    type: ExamQuestionType,
    difficulty: DifficultyLevel,
    knowledgePrefix: string,
    topics?: string[],
    focusAreas?: string[],
    promptConfig?: ResolvedAIPrompt,
    coverageHints?: QuestionCoverageHints,
    choiceOptionCount?: number
  ): Promise<{ question: GeneratedQuestion; tokensUsed: number; generationPrompt: string }> {
    const knowledgePrefixHash = createHash('sha256').update(knowledgePrefix).digest('hex');
    const taskPrompt = this.buildGenerationTaskPrompt(
      type,
      difficulty,
      topics,
      focusAreas,
      knowledgePrefixHash,
      coverageHints,
      choiceOptionCount
    );
    const effectivePromptConfig =
      promptConfig ??
      (await AIPromptResolverService.resolve({
        useCase: AIPromptUseCase.EXAM_GENERATION,
      }));

    const userTemplate = effectivePromptConfig.userPrompt ?? '{{knowledgeXml}}\n\n{{taskPrompt}}';
    const prompt = AIPromptResolverService.render(userTemplate, {
      knowledgeXml: knowledgePrefix,
      taskPrompt,
    });

    // Call the configured LLM provider.
    const normalizedChoiceOptionCount = this.normalizeChoiceOptionCount(choiceOptionCount);
    const choicePolicy = type === ExamQuestionType.SINGLE_CHOICE || type === ExamQuestionType.MULTIPLE_CHOICE
      ? `\n\nFor this request, generate exactly ${normalizedChoiceOptionCount} answer options labeled A-${String.fromCharCode(64 + normalizedChoiceOptionCount)}. This request-specific rule overrides any default four-option instruction.`
      : '';
    const messages = [
      { role: 'system' as const, content: `${effectivePromptConfig.systemPrompt}${choicePolicy}` },
      { role: 'user' as const, content: prompt },
    ];
    const response = await createLLMChatCompletion({
      provider: effectivePromptConfig.provider,
      model: effectivePromptConfig.model,
      messages,
      responseFormat: effectivePromptConfig.responseFormat,
      temperature: effectivePromptConfig.temperature,
      maxTokens: effectivePromptConfig.maxTokens,
      logContext: {
        useCase: 'exam-generation',
        promptChars: prompt.length,
      },
    });

    const result = JSON.parse(response.content || '{}');
    const normalized = this.normalizeGeneratedQuestion(type, difficulty, result, normalizedChoiceOptionCount);

    return {
      question: {
        type,
        difficulty,
        question: normalized.question,
        options: normalized.options,
        correctAnswer: normalized.correctAnswer,
        rubric: normalized.rubric,
        sampleAnswer: normalized.sampleAnswer,
        explanation: normalized.explanation,
        topic: normalized.topic || topics?.[0],
        sourceChunkIds: [],
        confidence: normalized.confidence,
      },
      tokensUsed: response.usage?.totalTokens || 0,
      generationPrompt: taskPrompt,
    };
  }

  /**
   * Normalize OpenAI output into the canonical DB format.
   *
   * Canonical formats (matches admin UI + schema comment):
   * - SINGLE_CHOICE: `correctAnswer` is the option index as a string: "0".."5"
   * - MULTIPLE_CHOICE: `correctAnswer` is a comma-separated list of option indexes, e.g. "0,2"
   * - TRUE_FALSE: `correctAnswer` is "true" or "false"
   * - FILL_IN_BLANK: free-form string (not auto-graded)
   * - ESSAY: use rubric + sampleAnswer; `correctAnswer` is not required
   */
  private normalizeGeneratedQuestion(
    type: ExamQuestionType,
    difficulty: DifficultyLevel,
    raw: any,
    choiceOptionCount = 4
  ): GeneratedQuestion {
    const question = typeof raw?.question === 'string' ? raw.question.trim() : '';
    const explanation = typeof raw?.explanation === 'string' ? raw.explanation.trim() : undefined;
    const topic = typeof raw?.topic === 'string' ? raw.topic.trim() : undefined;
    const confidence =
      typeof raw?.confidence === 'number' && Number.isFinite(raw.confidence)
        ? Math.max(0, Math.min(raw.confidence, 1))
        : 0.8;

    if (type === ExamQuestionType.SINGLE_CHOICE || type === ExamQuestionType.MULTIPLE_CHOICE) {
      let options = Array.isArray(raw?.options)
        ? raw.options
            .map((o: any) => String(o).trim())
            .filter((o: string) => o.length > 0)
        : [];

      const expectedOptionCount = this.normalizeChoiceOptionCount(choiceOptionCount);
      // Normalize model output to the option count selected for this generation run.
      if (options.length === 0) {
        options = this.buildPlaceholderOptions(expectedOptionCount);
      } else if (options.length !== expectedOptionCount) {
        options = options.slice(0, expectedOptionCount);
        while (options.length < expectedOptionCount) {
          const label = String.fromCharCode(65 + options.length);
          options.push(`Option ${label}`);
        }
      }

      const correctAnswer = type === ExamQuestionType.SINGLE_CHOICE
        ? this.normalizeMultipleChoiceCorrectAnswer(raw, options)
        : this.normalizeMultipleChoiceMultiAnswer(raw, options);
      if (correctAnswer == null) {
        throw new Error(type === ExamQuestionType.SINGLE_CHOICE
          ? 'INVALID_SINGLE_CHOICE_CORRECT_ANSWER'
          : 'INVALID_MULTIPLE_CHOICE_CORRECT_ANSWER');
      }
      const rebalanced = this.rebalanceMultipleChoiceOptionOrder(options, correctAnswer);
      return {
        type,
        difficulty,
        question,
        options: rebalanced.options,
        correctAnswer: rebalanced.correctAnswer,
        explanation,
        topic,
        sourceChunkIds: [],
        confidence,
      } as GeneratedQuestion;
    }

    if (type === ExamQuestionType.TRUE_FALSE) {
      const correctAnswer = this.normalizeTrueFalseCorrectAnswer(raw?.correctAnswer);
      if (correctAnswer == null) {
        throw new Error('INVALID_TRUE_FALSE_CORRECT_ANSWER');
      }
      return {
        type,
        difficulty,
        question,
        correctAnswer,
        explanation,
        topic,
        sourceChunkIds: [],
        confidence,
      } as GeneratedQuestion;
    }

    if (type === ExamQuestionType.FILL_IN_BLANK) {
      const correctAnswer = typeof raw?.correctAnswer === 'string' ? raw.correctAnswer.trim() : '';
      if (!correctAnswer) {
        throw new Error('INVALID_FILL_IN_BLANK_CORRECT_ANSWER');
      }
      return {
        type,
        difficulty,
        question,
        correctAnswer,
        explanation,
        topic,
        sourceChunkIds: [],
        confidence,
      } as GeneratedQuestion;
    }

    // ESSAY
    const rubric = typeof raw?.rubric === 'string' ? raw.rubric.trim() : '';
    const sampleAnswer = typeof raw?.sampleAnswer === 'string' ? raw.sampleAnswer.trim() : '';

    // Newer models may occasionally omit rubric/sampleAnswer even when prompted.
    // Keep generation resilient by filling safe defaults instead of failing the entire question.
    const fallbackRubric =
      'Scoring guide: Accuracy (40%), Depth of analysis (30%), Practical examples (20%), Clarity and structure (10%).';
    const fallbackSampleAnswer = explanation || 'Provide a complete answer grounded in the lesson knowledge context.';

    return {
      type,
      difficulty,
      question,
      rubric: rubric || fallbackRubric,
      sampleAnswer: sampleAnswer || fallbackSampleAnswer,
      explanation,
      topic,
      sourceChunkIds: [],
      confidence,
    } as GeneratedQuestion;
  }

  private normalizeMultipleChoiceCorrectAnswer(raw: any, options: string[]): string | null {
    // Accept arrays (use first), single index, letter, or text match. Fallback to 0 if still missing.
    if (Array.isArray(raw?.correctAnswerIndexes) && raw.correctAnswerIndexes.length > 0) {
      const idx = Number.parseInt(String(raw.correctAnswerIndexes[0]), 10);
      if (Number.isFinite(idx) && idx >= 0 && idx < options.length) return String(idx);
    }
    if (Array.isArray(raw?.correctAnswers) && raw.correctAnswers.length > 0) {
      const idx = Number.parseInt(String(raw.correctAnswers[0]), 10);
      if (Number.isFinite(idx) && idx >= 0 && idx < options.length) return String(idx);
    }

    // Prefer explicit numeric index.
    const idxRaw = raw?.correctAnswerIndex;
    if (typeof idxRaw === 'number' && Number.isFinite(idxRaw)) {
      const idx = Math.floor(idxRaw);
      if (idx >= 0 && idx < options.length) return String(idx);
    }

    const ca = raw?.correctAnswer;
    if (typeof ca === 'number' && Number.isFinite(ca)) {
      const idx = Math.floor(ca);
      if (idx >= 0 && idx < options.length) return String(idx);
    }

    if (typeof ca === 'string') {
      const trimmed = ca.trim();
      // Accept letter format "A".."D".
      if (/^[A-Da-d]$/.test(trimmed)) {
        const idx = trimmed.toUpperCase().charCodeAt(0) - 65;
        if (idx >= 0 && idx < options.length) return String(idx);
      }
      // Accept index string "0".."3".
      if (/^\d+$/.test(trimmed)) {
        const idx = Number.parseInt(trimmed, 10);
        if (Number.isFinite(idx) && idx >= 0 && idx < options.length) return String(idx);
      }
      // Accept option text (best-effort fallback).
      const matchIdx = options.findIndex((o) => o.trim() === trimmed);
      if (matchIdx >= 0) return String(matchIdx);
    }

    // As a last resort, default to the first option to avoid dropping the question entirely.
    return options.length > 0 ? '0' : null;
  }

  /**
   * Normalize multi-answer MC (comma-separated string of indexes).
   */
  private normalizeMultipleChoiceMultiAnswer(raw: any, options: string[]): string | null {
    const collect = (): number[] => {
      if (Array.isArray(raw?.correctAnswers)) {
        return raw.correctAnswers
          .map((v: any) => Number.parseInt(String(v), 10))
          .filter((n: number) => Number.isFinite(n) && n >= 0 && n < options.length);
      }
      if (Array.isArray(raw?.correctAnswerIndexes)) {
        return raw.correctAnswerIndexes
          .map((v: any) => Number.parseInt(String(v), 10))
          .filter((n: number) => Number.isFinite(n) && n >= 0 && n < options.length);
      }
      if (typeof raw?.correctAnswer === 'string') {
        const parts = raw.correctAnswer
          .split(',')
          .map((t: string) => Number.parseInt(t.trim(), 10))
          .filter((n: number) => Number.isFinite(n) && n >= 0 && n < options.length);
        if (parts.length) return parts;
      }
      if (typeof raw?.correctAnswerIndex === 'number') {
        const n = Math.floor(raw.correctAnswerIndex);
        if (n >= 0 && n < options.length) return [n];
      }
      if (typeof raw?.correctAnswer === 'number') {
        const n = Math.floor(raw.correctAnswer);
        if (n >= 0 && n < options.length) return [n];
      }
      return [];
    };

    const indexes = Array.from(new Set(collect()));
    if (!indexes.length) return null;
    return indexes.join(',');
  }

  /**
   * Rebalance answer-position distribution by shuffling options and remapping correct indexes.
   * This reduces model bias toward early options (A/B).
   */
  private rebalanceMultipleChoiceOptionOrder(
    options: string[],
    correctAnswer: string
  ): { options: string[]; correctAnswer: string } {
    if (!Array.isArray(options) || options.length < 2) {
      return { options, correctAnswer };
    }

    const correctIndexes = correctAnswer
      .split(',')
      .map((t) => Number.parseInt(t.trim(), 10))
      .filter((n) => Number.isFinite(n) && n >= 0 && n < options.length);
    if (correctIndexes.length === 0) {
      return { options, correctAnswer };
    }

    const shuffled = options.map((text, originalIndex) => ({ text, originalIndex }));
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    const oldToNewIndex = new Map<number, number>();
    shuffled.forEach((entry, newIndex) => {
      oldToNewIndex.set(entry.originalIndex, newIndex);
    });

    const remappedCorrect = Array.from(
      new Set(
        correctIndexes
          .map((oldIdx) => oldToNewIndex.get(oldIdx))
          .filter((idx): idx is number => idx !== undefined)
      )
    ).sort((a, b) => a - b);

    if (remappedCorrect.length === 0) {
      return { options, correctAnswer };
    }

    return {
      options: shuffled.map((entry) => entry.text),
      correctAnswer: remappedCorrect.join(','),
    };
  }

  private normalizeTrueFalseCorrectAnswer(value: unknown): 'true' | 'false' | null {
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value !== 'string') return null;
    const v = value.trim().toLowerCase();
    if (v === 'true') return 'true';
    if (v === 'false') return 'false';
    return null;
  }

  /**
   * Build a deterministic fallback question when AI generation fails.
   */
  private buildFallbackQuestion(
    type: ExamQuestionType,
    difficulty: DifficultyLevel,
    choiceOptionCount?: number
  ): GeneratedQuestion {
    const baseQuestion = 'Placeholder question generated due to AI failure.';
    const options = this.buildPlaceholderOptions(this.normalizeChoiceOptionCount(choiceOptionCount));

    switch (type) {
      case ExamQuestionType.SINGLE_CHOICE:
        return {
          type,
          difficulty,
          question: `${baseQuestion} (single choice)`,
          options,
          correctAnswer: '0',
          explanation: 'Fallback generated question.',
          sourceChunkIds: [],
          confidence: 0.1,
        };
      case ExamQuestionType.MULTIPLE_CHOICE:
        return {
          type,
          difficulty,
          question: `${baseQuestion} (multiple choice)`,
          options,
          correctAnswer: '0,1',
          explanation: 'Fallback generated question.',
          sourceChunkIds: [],
          confidence: 0.1,
        };
      case ExamQuestionType.TRUE_FALSE:
        return {
          type,
          difficulty,
          question: `${baseQuestion} (true/false)`,
          correctAnswer: 'true',
          explanation: 'Fallback generated question.',
          sourceChunkIds: [],
          confidence: 0.1,
        };
      case ExamQuestionType.FILL_IN_BLANK:
        return {
          type,
          difficulty,
          question: `${baseQuestion} (fill in blank with _____)`,
          correctAnswer: 'fallback',
          explanation: 'Fallback generated question.',
          sourceChunkIds: [],
          confidence: 0.1,
        };
      default:
        return {
          type: ExamQuestionType.ESSAY,
          difficulty,
          question: `${baseQuestion} (essay)`,
          rubric: 'Content and clarity.',
          sampleAnswer: 'Sample fallback answer.',
          sourceChunkIds: [],
          confidence: 0.1,
        };
    }
  }

  /**
   * Get system prompt for question generation
   */
  private getSystemPrompt(): string {
    return `You are an expert exam question generator. Your task is to create high-quality exam questions based on the provided learning content.

Rules:
1. Questions must be directly based on the provided content
2. Questions should test understanding, not just memorization
3. All information in questions must be factually accurate
4. Multiple choice questions should use the request-specific option count (4 to 6 options)
5. Distractors (wrong options) should be plausible but clearly incorrect
6. Essay questions should have clear rubrics and sample answers
7. Always provide explanations for the correct answers

Output format: JSON object with the following structure based on question type.`;
  }

  /**
   * Build generation prompt for specific question type
   */
  private buildGenerationTaskPrompt(
    type: ExamQuestionType,
    difficulty: DifficultyLevel,
    topics?: string[],
    focusAreas?: string[],
    knowledgePrefixHash?: string,
    coverageHints?: QuestionCoverageHints,
    choiceOptionCount?: number
  ): string {
    const difficultyDesc = {
      [DifficultyLevel.EASY]: 'basic understanding, straightforward questions',
      [DifficultyLevel.MEDIUM]: 'application of concepts, requires some analysis',
      [DifficultyLevel.HARD]: 'complex analysis, synthesis of multiple concepts',
    };

    let typePrompt = '';
    const optionCount = this.normalizeChoiceOptionCount(choiceOptionCount);
    const lastOptionLabel = String.fromCharCode(64 + optionCount);
    const optionIndexes = Array.from({ length: optionCount }, (_, index) => index).join(',');
    const optionExample = JSON.stringify(this.buildPlaceholderOptions(optionCount));

    switch (type) {
      case ExamQuestionType.SINGLE_CHOICE:
        typePrompt = `Generate a SINGLE CHOICE question with:
- A clear question stem
- Exactly ${optionCount} options labeled A through ${lastOptionLabel}
- Exactly one correct answer
- Return the single correct answer index as an integer from 0 to ${optionCount - 1}
- An explanation of why the answer is correct
- Do NOT systematically place the correct answer in A/B; distribute answer positions across ${optionIndexes} over multiple questions

Output JSON:
{
  "question": "The question text",
  "options": ${optionExample},
  "correctAnswerIndex": 2,
  "explanation": "Why the answer is correct",
  "topic": "Main topic tested",
  "confidence": 0.9
}`;
        break;

      case ExamQuestionType.MULTIPLE_CHOICE:
        typePrompt = `Generate a MULTIPLE CHOICE question with:
- A clear question stem
- Exactly ${optionCount} options labeled A through ${lastOptionLabel} (one or more correct answers)
- Return all correct answers in an array (indexes 0-${optionCount - 1})
- An explanation of why the correct answer(s) are correct
- Do NOT systematically place correct answers in A/B; distribute answer positions across ${optionIndexes} over multiple questions

Output JSON:
{
  "question": "The question text",
  "options": ${optionExample},
  "correctAnswerIndexes": [2],
  "explanation": "Why the answer(s) are correct",
  "topic": "Main topic tested",
  "confidence": 0.9
}`;
        break;

      case ExamQuestionType.TRUE_FALSE:
        typePrompt = `Generate a TRUE/FALSE question with:
- A clear statement that is definitively true or false
- The correct answer (true or false)
- An explanation

Output JSON:
{
  "question": "The statement to evaluate",
  "correctAnswer": "true",
  "explanation": "Why it's true/false",
  "topic": "Main topic tested",
  "confidence": 0.9
}`;
        break;

      case ExamQuestionType.FILL_IN_BLANK:
        typePrompt = `Generate a FILL IN THE BLANK question with:
- A sentence with one key term blanked out (use _____ for the blank)
- The correct answer to fill in
- An explanation

Output JSON:
{
  "question": "The sentence with _____ for the blank",
  "correctAnswer": "the word/phrase that goes in the blank",
  "explanation": "Context for the answer",
  "topic": "Main topic tested",
  "confidence": 0.9
}`;
        break;

      case ExamQuestionType.ESSAY:
        typePrompt = `Generate an ESSAY question with:
- An open-ended question requiring detailed explanation
- A grading rubric with criteria and points
- A sample answer demonstrating expected response

Output JSON:
{
  "question": "The essay question",
  "rubric": "Grading criteria: Content (40%), Analysis (30%), Examples (20%), Clarity (10%)",
  "sampleAnswer": "A model answer showing expected depth and structure",
  "topic": "Main topic tested",
  "confidence": 0.85
}`;
        break;
    }

    const topicStr = topics?.length ? `Focus on these topics: ${topics.join(', ')}\n` : '';
    const focusStr = focusAreas?.length ? `Emphasize these areas: ${focusAreas.join(', ')}\n` : '';
    const coverageStr = coverageHints
      ? `Coverage requirements (critical):
- This is question ${coverageHints.questionIndex} of ${coverageHints.totalQuestions}
- Preferred topic(s) for THIS question: ${coverageHints.preferredTopics.length ? coverageHints.preferredTopics.join(' | ') : 'Pick an important uncovered topic from the XML'}
- Already covered topics: ${coverageHints.alreadyCoveredTopics.length ? coverageHints.alreadyCoveredTopics.join(' | ') : 'None yet'}
- Avoid repeating these topics: ${coverageHints.avoidTopics.length ? coverageHints.avoidTopics.join(' | ') : 'N/A'}
- Avoid near-duplicate stems of recent questions:
${coverageHints.recentQuestionStems.length ? coverageHints.recentQuestionStems.map((q) => `  - ${q}`).join('\n') : '  - None yet'}
- Do not generate another question that tests the same micro-topic unless unavoidable.
- Prioritize broad coverage of the full XML (beginning/middle/end and major sections), with extra weight on key takeaways and core concepts.
`
      : '';

    return `KnowledgePrefixHash: ${knowledgePrefixHash ?? 'unknown'}

Based on the COURSE_KNOWLEDGE_XML above, generate a ${difficulty.toLowerCase()} difficulty question.

Difficulty level: ${difficultyDesc[difficulty]}
${topicStr}${focusStr}
${coverageStr}

${typePrompt}`;
  }

  private wrapCdata(text: string): string {
    // Avoid terminating CDATA.
    return text.replaceAll(']]>', ']]]]><![CDATA[>');
  }

  private escapeAttr(text: string): string {
    return text
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  }

  private escapeText(text: string): string {
    return text
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  }

  /**
   * Get random difficulty for mixed mode
   */
  private getRandomDifficulty(): DifficultyLevel {
    const difficulties = [DifficultyLevel.EASY, DifficultyLevel.MEDIUM, DifficultyLevel.HARD];
    // Weighted: 30% easy, 50% medium, 20% hard
    const weights = [0.3, 0.5, 0.2];
    const random = Math.random();
    let cumulative = 0;

    for (let i = 0; i < difficulties.length; i++) {
      cumulative += weights[i];
      if (random <= cumulative) {
        return difficulties[i];
      }
    }

    return DifficultyLevel.MEDIUM;
  }

  private normalizeTopicKey(topic: string): string {
    return topic
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private extractCoverageTopicsFromKnowledgePrefix(knowledgePrefix: string): CoverageTopic[] {
    const results: CoverageTopic[] = [];
    const seen = new Set<string>();
    const anchorIndexRegex = /<anchor_index>([\s\S]*?)<\/anchor_index>/g;
    let match: RegExpExecArray | null = null;

    while ((match = anchorIndexRegex.exec(knowledgePrefix)) !== null) {
      const raw = this.unescapeXml(match[1] ?? '').trim();
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) continue;
        for (const item of parsed) {
          if (!item || typeof item !== 'object') continue;
          const title = typeof item.title === 'string' ? item.title.trim() : '';
          if (!title) continue;
          const key = this.normalizeTopicKey(title);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          results.push({
            title,
            anchorType: typeof item.type === 'string' ? item.type : undefined,
            timestamp: typeof item.timestamp === 'string' ? item.timestamp : undefined,
          });
        }
      } catch {
        continue;
      }
    }

    const weightedTypeOrder = ['KEY_TAKEAWAY', 'CONCEPT', 'EXAMPLE', 'DEMO'];
    const parseTimestamp = (ts?: string): number => {
      if (!ts) return Number.MAX_SAFE_INTEGER;
      const parts = ts.split(':').map((p) => Number.parseInt(p, 10));
      if (parts.some((n) => !Number.isFinite(n) || n < 0)) return Number.MAX_SAFE_INTEGER;
      if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
      if (parts.length === 2) return parts[0] * 60 + parts[1];
      return Number.MAX_SAFE_INTEGER;
    };
    return results.sort((a, b) => {
      const aRank = weightedTypeOrder.indexOf((a.anchorType || '').toUpperCase());
      const bRank = weightedTypeOrder.indexOf((b.anchorType || '').toUpperCase());
      const aScore = aRank === -1 ? 999 : aRank;
      const bScore = bRank === -1 ? 999 : bRank;
      if (aScore !== bScore) return aScore - bScore;
      const aTs = parseTimestamp(a.timestamp);
      const bTs = parseTimestamp(b.timestamp);
      if (aTs !== bTs) return aTs - bTs;
      return a.title.localeCompare(b.title);
    });
  }

  private selectPreferredCoverageTopics(
    coverageTopics: CoverageTopic[],
    coveredTopicKeys: Set<string>,
    topics?: string[],
    focusAreas?: string[]
  ): string[] {
    const uncoveredFromAnchors = coverageTopics
      .filter((t) => !coveredTopicKeys.has(this.normalizeTopicKey(t.title)))
      .map((t) => t.title);
    if (uncoveredFromAnchors.length > 0) {
      return uncoveredFromAnchors.slice(0, 6);
    }

    const fromInputs = [...(focusAreas || []), ...(topics || [])]
      .map((t) => String(t).trim())
      .filter(Boolean);
    return Array.from(new Set(fromInputs)).slice(0, 6);
  }

  private trackCoveredTopic(
    coveredTopicKeys: Set<string>,
    coveredTopicTitles: string[],
    coverageTopics: CoverageTopic[],
    generatedTopic?: string,
    fallbackTopic?: string
  ): void {
    const register = (topic: string) => {
      const key = this.normalizeTopicKey(topic);
      if (!key || coveredTopicKeys.has(key)) return;
      coveredTopicKeys.add(key);
      coveredTopicTitles.push(topic);
    };

    const generated = generatedTopic?.trim();
    if (generated) {
      register(generated);

      const generatedKey = this.normalizeTopicKey(generated);
      const matched = coverageTopics.find((t) => {
        const topicKey = this.normalizeTopicKey(t.title);
        return (
          generatedKey === topicKey ||
          generatedKey.includes(topicKey) ||
          topicKey.includes(generatedKey)
        );
      });
      if (matched) register(matched.title);
      return;
    }

    if (fallbackTopic?.trim()) {
      register(fallbackTopic.trim());
    }
  }

  private unescapeXml(text: string): string {
    return text
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&amp;', '&');
  }

  /**
   * Regenerate a specific question
   */
  async regenerateQuestion(
    questionId: string,
    config?: Partial<GenerationConfig>
  ): Promise<GeneratedQuestion> {
    const existingQuestion = await prisma.examQuestion.findUnique({
      where: { id: questionId },
      include: {
        exam: {
          include: {
            materials: {
              where: { status: 'READY' },
              include: { chunks: true },
            },
            course: {
              include: {
                chapters: {
                  include: {
                    lessons: {
                      include: {
                        transcripts: {
                          where: { status: 'READY' },
                          include: { chunks: true },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        sources: {
          include: { chunk: true },
        },
      },
    });

    if (!existingQuestion) {
      throw new Error('QUESTION_NOT_FOUND');
    }

    const knowledgePrefix = await this.buildKnowledgePrefixOrThrow(existingQuestion.exam);
    const result = await this.generateSingleQuestion(
      existingQuestion.type,
      config?.difficulty as DifficultyLevel || existingQuestion.difficulty,
      knowledgePrefix,
      config?.topics,
      config?.focusAreas,
      undefined,
      undefined,
      config?.choiceOptionCount ?? (existingQuestion.options as string[] | null)?.length
    );

    // Update the question
    await prisma.examQuestion.update({
      where: { id: questionId },
      data: {
        question: result.question.question,
        options: result.question.options,
        correctAnswer: result.question.correctAnswer,
        rubric: result.question.rubric,
        sampleAnswer: result.question.sampleAnswer,
        explanation: result.question.explanation,
        topic: result.question.topic,
        difficulty: result.question.difficulty,
        isAIGenerated: true,
        aiModel: 'gpt-4o-mini',
        generationPrompt: result.generationPrompt,
      },
    });

    // Clear source links; XML knowledge context isn't represented as MaterialChunk sources.
    await prisma.examQuestionSource.deleteMany({
      where: { questionId },
    });

    return result.question;
  }
}
