import { AuthUser } from '@/lib/auth-middleware'
import {
    getSmeMcpToolAnnotations,
    isToolExposedOnStandardMcpServer,
} from '@/lib/mcp-production-policy'
import { SmeMcpService } from '@/lib/services/sme-mcp.service'
import {
    getSmeMcpToolMetadata,
    getSmeMcpToolParameterMetadata,
    smeMcpToolMetadataByName,
} from '@/lib/sme-mcp-tool-metadata'
import { inviteUsersSchema } from '@/lib/validations'
import { DifficultyLevel, ExamQuestionType, LessonAssetType } from '@prisma/client'
import { z } from 'zod'

type MappableUser = Pick<AuthUser, 'id' | 'role'>

export type SmeMcpToolExecutionResult = {
    success: true
    tool: string
    summary: string
    data: unknown
    nextActions: string[]
    recommendedNextInputs?: Record<string, unknown>
    warnings?: string[]
}

type JsonSchema = Record<string, unknown>

type SmeMcpToolDefinition<TInput = unknown> = {
    name: string
    description: string
    inputSchema: z.ZodType<TInput>
    inputJsonSchema: JsonSchema
    execute: (user: MappableUser, input: TInput) => Promise<SmeMcpToolExecutionResult>
}

const uuidSchema = {
    type: 'string',
    format: 'uuid',
} satisfies JsonSchema

const describedUuidSchema = (description: string, example?: string) =>
    ({
        ...uuidSchema,
        description,
        ...(example ? { examples: [example] } : {}),
    }) satisfies JsonSchema

const describedStringSchema = (
    description: string,
    options?: {
        minLength?: number
        maxLength?: number
        examples?: string[]
        format?: string
        enum?: readonly string[]
        nullable?: boolean
    }
) =>
    ({
        type: options?.nullable ? ['string', 'null'] : 'string',
        description,
        ...(options?.minLength === undefined ? {} : { minLength: options.minLength }),
        ...(options?.maxLength === undefined ? {} : { maxLength: options.maxLength }),
        ...(options?.format ? { format: options.format } : {}),
        ...(options?.enum ? { enum: options.enum } : {}),
        ...(options?.examples ? { examples: options.examples } : {}),
    }) satisfies JsonSchema

const describedBooleanSchema = (description: string, defaultValue?: boolean) =>
    ({
        type: 'boolean',
        description,
        ...(defaultValue === undefined ? {} : { default: defaultValue }),
    }) satisfies JsonSchema

const describedIntegerSchema = (
    description: string,
    options?: { minimum?: number; maximum?: number; examples?: number[]; nullable?: boolean }
) =>
    ({
        type: options?.nullable ? ['integer', 'null'] : 'integer',
        description,
        ...(options?.minimum === undefined ? {} : { minimum: options.minimum }),
        ...(options?.maximum === undefined ? {} : { maximum: options.maximum }),
        ...(options?.examples ? { examples: options.examples } : {}),
    }) satisfies JsonSchema

const parseArrayExample = (rawExample?: unknown) => {
    if (!rawExample) return undefined

    if (Array.isArray(rawExample)) {
        return rawExample.filter((value): value is string => typeof value === 'string')
    }

    try {
        const parsed = JSON.parse(String(rawExample))
        return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : undefined
    } catch {
        return undefined
    }
}

const describedUuidArraySchema = (description: string, options?: { example?: string; minItems?: number }) =>
    ({
        type: 'array',
        description,
        items: uuidSchema,
        ...(options?.minItems === undefined ? {} : { minItems: options.minItems }),
        ...(parseArrayExample(options?.example) ? { examples: [parseArrayExample(options?.example)] } : {}),
    }) satisfies JsonSchema

const describedStringArraySchema = (
    description: string,
    options?: { example?: unknown; minItems?: number }
) =>
    ({
        type: 'array',
        description,
        items: { type: 'string' },
        ...(options?.minItems === undefined ? {} : { minItems: options.minItems }),
        ...(Array.isArray(options?.example) ? { examples: [options?.example] } : {}),
    }) satisfies JsonSchema

const describedObjectSchema = (
    description: string,
    properties: Record<string, unknown>,
    options?: { required?: string[]; example?: unknown }
) =>
    ({
        type: 'object',
        description,
        properties,
        ...(options?.required ? { required: options.required } : {}),
        additionalProperties: false,
        ...(options?.example ? { examples: [options.example] } : {}),
    }) satisfies JsonSchema

const toolInputDescription = (toolName: keyof typeof smeMcpToolMetadataByName) => getSmeMcpToolMetadata(toolName).inputSummary

const parameterDescription = (
    toolName: keyof typeof smeMcpToolMetadataByName,
    parameterName: string,
    fallback: string
) => getSmeMcpToolParameterMetadata(toolName, parameterName)?.description ?? fallback

// Metadata examples intentionally support every JSON-compatible parameter shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parameterExample = (toolName: keyof typeof smeMcpToolMetadataByName, parameterName: string): any =>
    getSmeMcpToolParameterMetadata(toolName, parameterName)?.example

const parameterAcceptedValues = (toolName: keyof typeof smeMcpToolMetadataByName, parameterName: string) =>
    getSmeMcpToolParameterMetadata(toolName, parameterName)?.acceptedValues
        ?.map((option) => option.value)
        .filter((value): value is string => typeof value === 'string')

const emptyObjectJsonSchema = {
    type: 'object',
    description: 'This tool does not require any input arguments.',
    properties: {},
    additionalProperties: false,
} satisfies JsonSchema

const listWorkspaceSchema = z.object({
    domainId: z.string().uuid().optional(),
})

const createBadgeSchema = z.object({
    name: z.string().trim().min(1).max(120),
    domain: z.string().trim().min(1).max(160),
    thresholdStars: z.number().int().min(1).max(1000),
    icon: z.string().trim().max(32).optional().nullable(),
    description: z.string().trim().optional().nullable(),
    active: z.boolean().optional(),
})

const createSeriesSchema = z.object({
    name: z.string().trim().min(1).max(160),
    seriesType: z.enum(['WEEKLY_DRILL', 'CASE_STUDY', 'KNOWLEDGE_SHARING', 'FAQ_SHARE', 'RELEASE_READINESS', 'QUARTERLY_FINAL', 'YEAR_END_FINAL']),
    productDomain: z.string().trim().min(1).max(160),
    seriesOwner: z.string().trim().min(1).max(255).optional().nullable(),
    cadence: z.string().trim().max(120).optional().nullable(),
    description: z.string().trim().optional().nullable(),
    active: z.boolean().optional(),
    contributesToDomainBadges: z.boolean().optional(),
})

const createLearningProgramSchema = z.object({
    name: z.string().trim().min(1).max(160),
    programType: createSeriesSchema.shape.seriesType.optional(),
    seriesType: createSeriesSchema.shape.seriesType.optional(),
    productDomain: z.string().trim().min(1).max(160),
    programOwner: z.string().trim().min(1).max(255).optional().nullable(),
    seriesOwner: z.string().trim().min(1).max(255).optional().nullable(),
    cadence: z.string().trim().max(120).optional().nullable(),
    description: z.string().trim().optional().nullable(),
    active: z.boolean().optional(),
    contributesToDomainBadges: z.boolean().optional(),
}).superRefine((value, ctx) => {
    if (!value.programType && !value.seriesType) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['programType'], message: 'programType is required.' })
    }
    if (value.programType && value.seriesType && value.programType !== value.seriesType) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['seriesType'],
            message: 'programType and seriesType must match when both are provided.',
        })
    }
    if (value.programOwner && value.seriesOwner && value.programOwner !== value.seriesOwner) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['seriesOwner'],
            message: 'programOwner and seriesOwner must match when both are provided.',
        })
    }
})

const createEventSchema = z.object({
    title: z.string().trim().min(1).max(200),
    learningProgram: z.string().trim().min(1).max(200).optional(),
    learningSeries: z.string().trim().min(1).max(200).optional(),
    format: z.enum(['CASE_STUDY', 'KNOWLEDGE_SHARING', 'FAQ_SHARE', 'RELEASE_BRIEFING', 'QUIZ_REVIEW', 'FINAL_EXAM', 'WORKSHOP']),
    status: z.enum(['IN_PROGRESS', 'COMPLETED']).optional(),
    host: z.string().trim().min(1).max(255).optional().nullable(),
    productDomain: z.string().trim().min(1).max(160).optional().nullable(),
    description: z.string().trim().optional().nullable(),
    scheduledAt: z.coerce.date().optional().nullable(),
    countsTowardPerformance: z.boolean().optional(),
}).superRefine((value, ctx) => {
    if (!value.learningProgram && !value.learningSeries && !value.productDomain) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['productDomain'],
            message: 'Provide learningProgram (preferred), learningSeries (compatibility alias), or productDomain.',
        })
    }

    if (value.learningProgram && value.learningSeries && value.learningProgram !== value.learningSeries) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['learningSeries'],
            message: 'learningProgram and learningSeries must reference the same program when both are provided.',
        })
    }

})

const createCourseSchema = z.object({
    title: z.string().trim().min(1).max(200),
    event: z.string().trim().min(1).max(200).optional().nullable(),
    description: z.string().trim().optional().nullable(),
    whatYouWillLearn: z.array(z.string().trim().min(1)).optional(),
    requirements: z.array(z.string().trim().min(1)).optional(),
    thumbnailUrl: z.string().trim().optional().nullable(),
    category: z.string().trim().max(120).optional().nullable(),
    level: z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED']).optional(),
    status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional(),
    instructor: z.string().trim().min(1).max(255).optional().nullable(),
    tags: z.array(z.string().trim().min(1)).optional(),
})

const createExamSchema = z.object({
    title: z.string().trim().min(1).max(200),
    event: z.string().trim().min(1).max(200).optional().nullable(),
    description: z.string().trim().optional().nullable(),
    instructions: z.string().trim().optional().nullable(),
    examType: z.enum(['PRACTICE', 'READINESS', 'FORMAL']).default('PRACTICE'),
    awardsStars: z.boolean().default(true),
    starValue: z.number().int().min(0).max(20).default(3),
    countsTowardPerformance: z.boolean().default(false),
    totalScore: z.number().int().positive(),
    passingScore: z.number().int().nonnegative(),
    maxAttempts: z.number().int().positive(),
    options: z
        .object({
            timeLimit: z.number().int().positive().optional(),
            randomizeQuestions: z.boolean().optional(),
            randomizeOptions: z.boolean().optional(),
            showResultsImmediately: z.boolean().optional(),
            allowReview: z.boolean().optional(),
        })
        .optional()
        .nullable(),
})
    .superRefine((value, ctx) => {
        if (value.passingScore > value.totalScore) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['passingScore'],
                message: 'passingScore must be less than or equal to totalScore.',
            })
        }
    })

const attachExamToEventSchema = z.object({
    exam: z.string().trim().min(1).max(200),
    event: z.string().trim().min(1).max(200),
})

const designCourseSchema = z
    .object({
        course: z.string().trim().min(1).max(200),
        mode: z.enum(['generate_outline', 'manual_outline']),
        brief: z.string().trim().optional(),
        targetAudience: z.string().trim().optional().nullable(),
        lessonCount: z.number().int().positive().max(12).optional(),
        chapters: z
            .array(
                z.object({
                    title: z.string().trim().min(1).max(160),
                    description: z.string().trim().optional().nullable(),
                    lessons: z
                        .array(
                            z.object({
                                title: z.string().trim().min(1).max(160),
                                objective: z.string().trim().optional().nullable(),
                                summary: z.string().trim().optional().nullable(),
                            })
                        )
                        .min(1),
                })
            )
            .optional(),
        assetPlan: z
            .array(
                z.object({
                    lessonRef: z.string().trim().min(1).max(160),
                    assetType: z.nativeEnum(LessonAssetType),
                    title: z.string().trim().min(1).max(160),
                    sourceKind: z.enum(['upload', 'external_url', 's3_object']),
                    sourceBucket: z.string().trim().min(1).max(255).optional(),
                    sourceKey: z.string().trim().min(1).max(1024).optional(),
                    sourceRegion: z.string().trim().min(1).max(64).optional(),
                    sourceContentType: z.string().trim().min(1).max(120).optional(),
                    transcriptBucket: z.string().trim().min(1).max(255).optional(),
                    transcriptKey: z.string().trim().min(1).max(1024).optional(),
                    transcriptRegion: z.string().trim().min(1).max(64).optional(),
                    transcriptFormat: z.enum(['AUTO', 'TIMESTAMPED_TEXT', 'PLAIN_TEXT']).optional(),
                    transcriptLanguage: z.string().trim().min(2).max(20).optional(),
                    transcriptLabel: z.string().trim().max(80).optional().nullable(),
                    setTranscriptAsDefaultSubtitle: z.boolean().optional(),
                    setTranscriptAsPrimaryForAI: z.boolean().optional(),
                    processKnowledge: z.boolean().optional(),
                    transcriptNeeded: z.boolean().optional(),
                })
            )
            .optional(),
        transcriptPlan: z
            .array(
                z.object({
                    lessonRef: z.string().trim().min(1).max(160),
                    languageCode: z.string().trim().min(2).max(20).optional(),
                    setAsDefaultSubtitle: z.boolean().optional(),
                    setAsPrimaryForAI: z.boolean().optional(),
                })
            )
            .optional(),
    })
    .superRefine((value, ctx) => {
        if (value.mode === 'generate_outline' && !value.brief?.trim()) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['brief'],
                message: 'brief is required when mode is generate_outline.',
            })
        }

        if (value.mode === 'manual_outline' && (!value.chapters || value.chapters.length === 0)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['chapters'],
                message: 'chapters are required when mode is manual_outline.',
            })
        }

        value.assetPlan?.forEach((asset, index) => {
            if (asset.sourceKind === 's3_object' && (!asset.sourceBucket?.trim() || !asset.sourceKey?.trim())) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['assetPlan', index],
                    message: 'sourceBucket and sourceKey are required when sourceKind is s3_object.',
                })
            }

            if (asset.transcriptKey?.trim() && !asset.transcriptBucket?.trim() && !asset.sourceBucket?.trim()) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['assetPlan', index, 'transcriptBucket'],
                    message: 'transcriptBucket or sourceBucket is required when transcriptKey is provided.',
                })
            }
        })
    })

const manualQuestionSchema = z.object({
    type: z.nativeEnum(ExamQuestionType),
    difficulty: z.nativeEnum(DifficultyLevel).optional(),
    question: z.string().trim().min(1),
    options: z.array(z.string().trim().min(1)).min(2).max(6).optional(),
    correctAnswer: z.union([
        z.string().trim(),
        z.number(),
        z.array(z.union([z.string().trim(), z.number()])),
    ]).optional(),
    rubric: z.string().trim().optional(),
    sampleAnswer: z.string().trim().optional(),
    gradingCriteria: z.array(
        z.object({
            id: z.string().trim().min(1).optional(),
            title: z.string().trim().min(1),
            description: z.string().trim().optional().nullable(),
            maxPoints: z.number().int().positive(),
            guidance: z.string().trim().optional().nullable(),
            required: z.boolean().optional(),
        })
    ).optional().nullable(),
    maxWords: z.number().int().positive().optional(),
    points: z.number().int().positive().optional(),
    explanation: z.string().trim().optional(),
    topic: z.string().trim().optional(),
    tags: z.array(z.string().trim().min(1)).optional(),
})

const designExamQuestionsSchema = z
    .object({
        exam: z.string().trim().min(1).max(200),
        mode: z.enum(['generate_from_course', 'generate_from_event', 'manual_payload']),
        sourceCourse: z.string().trim().min(1).max(200).optional().nullable(),
        sourceEvent: z.string().trim().min(1).max(200).optional().nullable(),
        questionCount: z.number().int().positive().max(100).optional(),
        difficultyMix: z.union([z.nativeEnum(DifficultyLevel), z.literal('mixed')]).optional(),
        questionTypes: z.array(z.nativeEnum(ExamQuestionType)).optional(),
        choiceOptionCount: z.union([z.literal(4), z.literal(5), z.literal(6)]).optional(),
        coverageNotes: z.string().trim().optional().nullable(),
        generateEssayScoringCriteria: z.boolean().optional(),
        essayScoringStyle: z.enum(['concise', 'standard', 'detailed']).optional(),
        requireEssayAiReady: z.boolean().optional(),
        questions: z.array(manualQuestionSchema).optional(),
    })
    .superRefine((value, ctx) => {
        if (value.mode === 'generate_from_course' && !value.sourceCourse?.trim()) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['sourceCourse'],
                message: 'sourceCourse is required when mode is generate_from_course.',
            })
        }

        if (value.mode === 'generate_from_event' && !value.sourceEvent?.trim()) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['sourceEvent'],
                message: 'sourceEvent is required when mode is generate_from_event.',
            })
        }

        if (value.mode === 'manual_payload' && (!value.questions || value.questions.length === 0)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['questions'],
                message: 'questions are required when mode is manual_payload.',
            })
        }
    })

const reviewEventStatusSchema = z.object({
    event: z.string().trim().min(1).max(200),
})

const highRiskConfirmationFields = {
    dryRun: z.boolean().optional(),
    confirm: z.boolean().optional(),
    idempotencyKey: z.string().trim().min(8).max(200).optional(),
}

const highRiskControlJsonProperties = {
    dryRun: describedBooleanSchema('Preview the operation without changing data.', false),
    confirm: describedBooleanSchema('Explicitly confirm execution after reviewing the preview.', false),
    idempotencyKey: describedStringSchema('Optional caller-supplied request key for audit correlation. Assignment and invitation tools also deduplicate existing records.', {
        minLength: 8,
        maxLength: 200,
    }),
}

const shareCourseWithLearnersSchema = z.object({
    course: z.string().trim().min(1).max(200),
    userIds: inviteUsersSchema.shape.userIds,
    sendNotification: z.boolean().optional(),
    ...highRiskConfirmationFields,
})

const prepareTranscriptUploadSchema = z.object({
    lessonId: z.string().uuid(),
    videoAssetId: z.string().uuid().optional(),
    filename: z.string().trim().min(1).max(255),
    contentType: z.literal('text/vtt').optional(),
    languageCode: z.string().trim().min(2).max(20).optional(),
    label: z.string().trim().max(80).optional().nullable(),
    replaceExistingLanguage: z.boolean().optional(),
    setAsDefaultSubtitle: z.boolean().optional(),
    setAsPrimaryForAI: z.boolean().optional(),
    ...highRiskConfirmationFields,
})

const processTranscriptKnowledgeSchema = z.object({
    lessonId: z.string().uuid(),
    transcriptId: z.string().uuid().optional(),
    processTranscript: z.boolean().optional(),
    processKnowledge: z.boolean().optional(),
    force: z.boolean().optional(),
    knowledgePromptTemplateId: z.string().uuid().optional().nullable(),
    ...highRiskConfirmationFields,
})

const publishExamForLearnersSchema = z.object({
    exam: z.string().trim().min(1).max(200),
    userIds: z.array(z.string().uuid()).default([]),
    sendNotification: z.boolean().optional(),
    ...highRiskConfirmationFields,
})

const domainAssignmentSchema = z.object({
    objectType: z.enum(['PROGRAM', 'EVENT']),
    id: z.string().uuid(),
    domainId: z.string().uuid(),
})

const applyDomainAssignmentsSchema = z.object({
    assignments: z.array(domainAssignmentSchema).min(1).max(100),
    dryRun: z.boolean().optional().default(true),
    confirm: z.boolean().optional(),
    confirmationToken: z.string().length(64).optional(),
    idempotencyKey: z.string().trim().min(8).max(200).optional(),
}).superRefine((value, ctx) => {
    if (value.dryRun === false && value.confirm !== true) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['confirm'], message: 'confirm=true is required for apply.' })
    }
    if (value.dryRun === false && !value.confirmationToken) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['confirmationToken'], message: 'Use the token returned by dry-run.' })
    }
})

const manageDomainAliasSchema = z.object({
    domainId: z.string().uuid(),
    alias: z.string().trim().min(1).max(160),
    dryRun: z.boolean().optional().default(true),
    confirm: z.boolean().optional(),
    confirmationToken: z.string().length(64).optional(),
}).superRefine((value, ctx) => {
    if (value.dryRun === false && value.confirm !== true) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['confirm'], message: 'confirm=true is required for apply.' })
    }
    if (value.dryRun === false && !value.confirmationToken) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['confirmationToken'], message: 'Use the token returned by dry-run.' })
    }
})

export const deprecatedSmeMcpToolNames = [
    'upload_transcript_and_process',
    'list_course_editor_state',
    'update_course',
    'create_chapter',
    'update_chapter',
    'delete_chapter',
    'reorder_chapters',
    'create_lesson',
    'update_lesson',
    'delete_lesson',
    'reorder_lessons',
    'list_exam_questions',
    'create_exam_question',
    'update_exam_question',
    'delete_exam_question',
    'reorder_exam_questions',
] as const

export const smeMcpToolDefinitions = [
    {
        name: 'list_my_workspace',
        description: smeMcpToolMetadataByName.list_my_workspace.description,
        inputSchema: listWorkspaceSchema.default({}),
        inputJsonSchema: {
            type: 'object',
            description: toolInputDescription('list_my_workspace'),
            properties: {
                domainId: describedUuidSchema(
                    parameterDescription(
                        'list_my_workspace',
                        'domainId',
                        'Optional domain scope filter. Use a domain UUID returned by list_my_workspace.'
                    ),
                    parameterExample('list_my_workspace', 'domainId')
                ),
            },
            additionalProperties: false,
            examples: [{}, { domainId: parameterExample('list_my_workspace', 'domainId') }],
        },
        execute: (user, input) => SmeMcpService.listMyWorkspace(user, input as z.infer<typeof listWorkspaceSchema>),
    },
    {
        name: 'get_training_ops_action_center',
        description: smeMcpToolMetadataByName.get_training_ops_action_center.description,
        inputSchema: listWorkspaceSchema.default({}),
        inputJsonSchema: {
            type: 'object',
            description: toolInputDescription('get_training_ops_action_center'),
            properties: {
                domainId: describedUuidSchema('Optional Domain Scope UUID returned by list_my_workspace.'),
            },
            additionalProperties: false,
        },
        execute: (user, input) =>
            SmeMcpService.getTrainingOpsActionCenter(user, input as z.infer<typeof listWorkspaceSchema>),
    },
    {
        name: 'get_domain_health',
        description: smeMcpToolMetadataByName.get_domain_health.description,
        inputSchema: listWorkspaceSchema.default({}),
        inputJsonSchema: {
            type: 'object',
            description: toolInputDescription('get_domain_health'),
            properties: {
                domainId: describedUuidSchema('Optional Domain Scope UUID returned by list_my_workspace.'),
            },
            additionalProperties: false,
        },
        execute: (user, input) =>
            SmeMcpService.getDomainHealth(user, input as z.infer<typeof listWorkspaceSchema>),
    },
    {
        name: 'audit_domain_associations',
        description: smeMcpToolMetadataByName.audit_domain_associations.description,
        inputSchema: z.object({}).default({}),
        inputJsonSchema: emptyObjectJsonSchema,
        execute: (user) => SmeMcpService.auditDomainAssociations(user),
    },
    {
        name: 'propose_domain_assignments',
        description: smeMcpToolMetadataByName.propose_domain_assignments.description,
        inputSchema: z.object({}).default({}),
        inputJsonSchema: emptyObjectJsonSchema,
        execute: (user) => SmeMcpService.proposeDomainAssignments(user),
    },
    {
        name: 'apply_domain_assignments',
        description: smeMcpToolMetadataByName.apply_domain_assignments.description,
        inputSchema: applyDomainAssignmentsSchema,
        inputJsonSchema: {
            type: 'object',
            description: toolInputDescription('apply_domain_assignments'),
            properties: {
                assignments: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 100,
                    items: {
                        type: 'object',
                        properties: {
                            objectType: { type: 'string', enum: ['PROGRAM', 'EVENT'] },
                            id: uuidSchema,
                            domainId: uuidSchema,
                        },
                        required: ['objectType', 'id', 'domainId'],
                        additionalProperties: false,
                    },
                },
                dryRun: describedBooleanSchema('Preview by default; set false only after reviewing the token.', true),
                confirm: describedBooleanSchema('Explicit confirmation required for apply.', false),
                confirmationToken: describedStringSchema('Exact 64-character token returned by the current dry-run.', { minLength: 64, maxLength: 64 }),
                idempotencyKey: describedStringSchema('Optional audit correlation key.', { minLength: 8, maxLength: 200 }),
            },
            required: ['assignments'],
            additionalProperties: false,
        },
        execute: (user, input) =>
            SmeMcpService.applyDomainAssignments(user, input as z.infer<typeof applyDomainAssignmentsSchema>),
    },
    {
        name: 'manage_domain_alias',
        description: smeMcpToolMetadataByName.manage_domain_alias.description,
        inputSchema: manageDomainAliasSchema,
        inputJsonSchema: {
            type: 'object',
            description: toolInputDescription('manage_domain_alias'),
            properties: {
                domainId: describedUuidSchema('Active Product Domain ID.'),
                alias: describedStringSchema('Exact alias to normalize and associate with the Domain.', { minLength: 1, maxLength: 160 }),
                dryRun: describedBooleanSchema('Preview by default.', true),
                confirm: describedBooleanSchema('Explicit confirmation required for apply.', false),
                confirmationToken: describedStringSchema('64-character token returned by dry-run.', { minLength: 64, maxLength: 64 }),
            },
            required: ['domainId', 'alias'],
            additionalProperties: false,
        },
        execute: (user, input) => SmeMcpService.manageDomainAlias(user, input as z.infer<typeof manageDomainAliasSchema>),
    },
    {
        name: 'create_badge',
        description: smeMcpToolMetadataByName.create_badge.description,
        inputSchema: createBadgeSchema,
        inputJsonSchema: {
            type: 'object',
            description: toolInputDescription('create_badge'),
            properties: {
                name: describedStringSchema(parameterDescription('create_badge', 'name', 'Required badge name.'), {
                    minLength: 1,
                    maxLength: 120,
                    examples: [String(parameterExample('create_badge', 'name') ?? '')],
                }),
                domain: describedStringSchema(parameterDescription('create_badge', 'domain', 'Required domain reference.'), {
                    minLength: 1,
                    maxLength: 160,
                    examples: [String(parameterExample('create_badge', 'domain') ?? '')],
                }),
                thresholdStars: describedIntegerSchema(
                    parameterDescription('create_badge', 'thresholdStars', 'Required threshold stars.'),
                    { minimum: 1, maximum: 1000, examples: [Number(parameterExample('create_badge', 'thresholdStars') ?? 4)] }
                ),
                icon: describedStringSchema(parameterDescription('create_badge', 'icon', 'Optional icon token.'), {
                    maxLength: 32,
                    examples: typeof parameterExample('create_badge', 'icon') === 'string' ? [parameterExample('create_badge', 'icon')] : undefined,
                    nullable: true,
                }),
                description: describedStringSchema(parameterDescription('create_badge', 'description', 'Optional description.'), {
                    examples: typeof parameterExample('create_badge', 'description') === 'string' ? [parameterExample('create_badge', 'description')] : undefined,
                    nullable: true,
                }),
                active: describedBooleanSchema(parameterDescription('create_badge', 'active', 'Optional active flag.'), true),
            },
            required: ['name', 'domain', 'thresholdStars'],
            additionalProperties: false,
            examples: [getSmeMcpToolMetadata('create_badge').minimalExample.input, getSmeMcpToolMetadata('create_badge').fullExample?.input].filter(Boolean),
        },
        execute: (user, input) => SmeMcpService.createBadge(user, input as z.infer<typeof createBadgeSchema>),
    },
    {
        name: 'create_series',
        description: smeMcpToolMetadataByName.create_series.description,
        inputSchema: createSeriesSchema,
        inputJsonSchema: {
            type: 'object',
            description: toolInputDescription('create_series'),
            properties: {
                name: describedStringSchema(parameterDescription('create_series', 'name', 'Required series name.'), {
                    minLength: 1,
                    maxLength: 160,
                    examples: [String(parameterExample('create_series', 'name') ?? '')],
                }),
                seriesType: describedStringSchema(parameterDescription('create_series', 'seriesType', 'Required series type.'), {
                    enum: parameterAcceptedValues('create_series', 'seriesType'),
                    examples: typeof parameterExample('create_series', 'seriesType') === 'string' ? [parameterExample('create_series', 'seriesType')] : undefined,
                }),
                productDomain: describedStringSchema(parameterDescription('create_series', 'productDomain', 'Required domain reference.'), {
                    minLength: 1,
                    maxLength: 160,
                    examples: [String(parameterExample('create_series', 'productDomain') ?? '')],
                }),
                seriesOwner: describedStringSchema(parameterDescription('create_series', 'seriesOwner', 'Optional series owner reference.'), {
                    examples: typeof parameterExample('create_series', 'seriesOwner') === 'string' ? [parameterExample('create_series', 'seriesOwner')] : undefined,
                    nullable: true,
                }),
                cadence: describedStringSchema(parameterDescription('create_series', 'cadence', 'Optional cadence label.'), {
                    maxLength: 120,
                    examples: typeof parameterExample('create_series', 'cadence') === 'string' ? [parameterExample('create_series', 'cadence')] : undefined,
                    nullable: true,
                }),
                description: describedStringSchema(parameterDescription('create_series', 'description', 'Optional description.'), {
                    examples: typeof parameterExample('create_series', 'description') === 'string' ? [parameterExample('create_series', 'description')] : undefined,
                    nullable: true,
                }),
                active: describedBooleanSchema(parameterDescription('create_series', 'active', 'Optional active flag.'), true),
                contributesToDomainBadges: describedBooleanSchema(
                    parameterDescription('create_series', 'contributesToDomainBadges', 'Optional badge-eligibility flag.'),
                    true
                ),
            },
            required: ['name', 'seriesType', 'productDomain'],
            additionalProperties: false,
            examples: [getSmeMcpToolMetadata('create_series').minimalExample.input, getSmeMcpToolMetadata('create_series').fullExample?.input].filter(Boolean),
        },
        execute: (user, input) => SmeMcpService.createSeries(user, input as z.infer<typeof createSeriesSchema>),
    },
    {
        name: 'create_learning_program',
        description: smeMcpToolMetadataByName.create_learning_program.description,
        inputSchema: createLearningProgramSchema,
        inputJsonSchema: {
            type: 'object',
            description: toolInputDescription('create_learning_program'),
            properties: {
                name: describedStringSchema('Required Learning Program name.', { minLength: 1, maxLength: 160 }),
                programType: describedStringSchema('Required program type.', {
                    enum: ['WEEKLY_DRILL', 'CASE_STUDY', 'KNOWLEDGE_SHARING', 'FAQ_SHARE', 'RELEASE_READINESS', 'QUARTERLY_FINAL', 'YEAR_END_FINAL'],
                }),
                seriesType: describedStringSchema('Compatibility alias for programType.', {
                    enum: ['WEEKLY_DRILL', 'CASE_STUDY', 'KNOWLEDGE_SHARING', 'FAQ_SHARE', 'RELEASE_READINESS', 'QUARTERLY_FINAL', 'YEAR_END_FINAL'],
                }),
                productDomain: describedStringSchema('Required owning Domain reference.', { minLength: 1, maxLength: 160 }),
                programOwner: describedStringSchema('Optional program owner reference.', { nullable: true }),
                seriesOwner: describedStringSchema('Optional program owner reference.', { nullable: true }),
                cadence: describedStringSchema('Optional cadence label.', { maxLength: 120, nullable: true }),
                description: describedStringSchema('Optional program description.', { nullable: true }),
                active: describedBooleanSchema('Whether the program is active immediately.', true),
                contributesToDomainBadges: describedBooleanSchema('Whether activity contributes to Domain badges.', true),
            },
            required: ['name', 'productDomain'],
            anyOf: [{ required: ['programType'] }, { required: ['seriesType'] }],
            additionalProperties: false,
            examples: [
                getSmeMcpToolMetadata('create_learning_program').minimalExample.input,
                getSmeMcpToolMetadata('create_learning_program').fullExample?.input,
            ].filter(Boolean),
        },
        execute: (user, rawInput) => {
            const input = rawInput as z.infer<typeof createLearningProgramSchema>
            return SmeMcpService.createSeries(user, {
                name: input.name,
                seriesType: input.programType ?? input.seriesType!,
                productDomain: input.productDomain,
                seriesOwner: input.programOwner ?? input.seriesOwner,
                cadence: input.cadence,
                description: input.description,
                active: input.active,
                contributesToDomainBadges: input.contributesToDomainBadges,
            }, 'create_learning_program')
        },
    },
    {
        name: 'create_event',
        description: smeMcpToolMetadataByName.create_event.description,
        inputSchema: createEventSchema,
        inputJsonSchema: {
            type: 'object',
            description: toolInputDescription('create_event'),
            properties: {
                title: describedStringSchema(parameterDescription('create_event', 'title', 'Required event title.'), {
                    minLength: 1,
                    maxLength: 200,
                    examples: [String(parameterExample('create_event', 'title') ?? '')],
                }),
                learningProgram: describedStringSchema(parameterDescription('create_event', 'learningProgram', 'Optional Learning Program reference.'), {
                    minLength: 1,
                    maxLength: 200,
                    examples: [String(parameterExample('create_event', 'learningProgram') ?? '')],
                }),
                learningSeries: describedStringSchema(parameterDescription('create_event', 'learningSeries', 'Compatibility alias for learningProgram.'), {
                    minLength: 1,
                    maxLength: 200,
                }),
                format: describedStringSchema(parameterDescription('create_event', 'format', 'Required event format.'), {
                    enum: parameterAcceptedValues('create_event', 'format'),
                    examples: typeof parameterExample('create_event', 'format') === 'string' ? [parameterExample('create_event', 'format')] : undefined,
                }),
                status: describedStringSchema(parameterDescription('create_event', 'status', 'Optional event status.'), {
                    enum: parameterAcceptedValues('create_event', 'status'),
                    examples: typeof parameterExample('create_event', 'status') === 'string' ? [parameterExample('create_event', 'status')] : undefined,
                }),
                host: describedStringSchema(parameterDescription('create_event', 'host', 'Optional host reference.'), {
                    examples: typeof parameterExample('create_event', 'host') === 'string' ? [parameterExample('create_event', 'host')] : undefined,
                    nullable: true,
                }),
                productDomain: describedStringSchema(parameterDescription('create_event', 'productDomain', 'Optional domain reference.'), {
                    examples: typeof parameterExample('create_event', 'productDomain') === 'string' ? [parameterExample('create_event', 'productDomain')] : undefined,
                    nullable: true,
                }),
                description: describedStringSchema(parameterDescription('create_event', 'description', 'Optional description.'), {
                    examples: typeof parameterExample('create_event', 'description') === 'string' ? [parameterExample('create_event', 'description')] : undefined,
                    nullable: true,
                }),
                scheduledAt: describedStringSchema(parameterDescription('create_event', 'scheduledAt', 'Optional scheduled datetime.'), {
                    format: 'date-time',
                    examples: typeof parameterExample('create_event', 'scheduledAt') === 'string' ? [parameterExample('create_event', 'scheduledAt')] : undefined,
                    nullable: true,
                }),
                countsTowardPerformance: describedBooleanSchema(
                    parameterDescription('create_event', 'countsTowardPerformance', 'Optional performance tracking flag.'),
                    false
                ),
            },
            required: ['title', 'format'],
            anyOf: [
                { required: ['learningProgram'] },
                { required: ['learningSeries'] },
                { required: ['productDomain'] },
            ],
            additionalProperties: false,
            examples: [getSmeMcpToolMetadata('create_event').minimalExample.input, getSmeMcpToolMetadata('create_event').fullExample?.input].filter(Boolean),
        },
        execute: (user, input) => SmeMcpService.createEvent(user, input as z.infer<typeof createEventSchema>),
    },
    {
        name: 'create_course',
        description: smeMcpToolMetadataByName.create_course.description,
        inputSchema: createCourseSchema,
        inputJsonSchema: {
            type: 'object',
            description: toolInputDescription('create_course'),
            properties: {
                title: describedStringSchema(parameterDescription('create_course', 'title', 'Required course title.'), {
                    minLength: 1,
                    maxLength: 200,
                    examples: [String(parameterExample('create_course', 'title') ?? '')],
                }),
                event: describedStringSchema(parameterDescription('create_course', 'event', 'Optional event reference.'), {
                    examples: typeof parameterExample('create_course', 'event') === 'string' ? [parameterExample('create_course', 'event')] : undefined,
                    nullable: true,
                }),
                description: describedStringSchema(parameterDescription('create_course', 'description', 'Optional description.'), {
                    examples: typeof parameterExample('create_course', 'description') === 'string' ? [parameterExample('create_course', 'description')] : undefined,
                    nullable: true,
                }),
                whatYouWillLearn: describedStringArraySchema(
                    parameterDescription('create_course', 'whatYouWillLearn', 'Optional learning outcomes array.'),
                    { example: parameterExample('create_course', 'whatYouWillLearn') }
                ),
                requirements: describedStringArraySchema(
                    parameterDescription('create_course', 'requirements', 'Optional requirements array.'),
                    { example: parameterExample('create_course', 'requirements') }
                ),
                thumbnailUrl: describedStringSchema(parameterDescription('create_course', 'thumbnailUrl', 'Optional thumbnail URL.'), {
                    examples: typeof parameterExample('create_course', 'thumbnailUrl') === 'string' ? [parameterExample('create_course', 'thumbnailUrl')] : undefined,
                    nullable: true,
                }),
                category: describedStringSchema(parameterDescription('create_course', 'category', 'Optional category label.'), {
                    examples: typeof parameterExample('create_course', 'category') === 'string' ? [parameterExample('create_course', 'category')] : undefined,
                    nullable: true,
                }),
                level: describedStringSchema(parameterDescription('create_course', 'level', 'Optional course level.'), {
                    enum: parameterAcceptedValues('create_course', 'level'),
                    examples: typeof parameterExample('create_course', 'level') === 'string' ? [parameterExample('create_course', 'level')] : undefined,
                }),
                status: describedStringSchema(parameterDescription('create_course', 'status', 'Optional course status.'), {
                    enum: parameterAcceptedValues('create_course', 'status'),
                    examples: typeof parameterExample('create_course', 'status') === 'string' ? [parameterExample('create_course', 'status')] : undefined,
                }),
                instructor: describedStringSchema(parameterDescription('create_course', 'instructor', 'Optional instructor reference.'), {
                    examples: typeof parameterExample('create_course', 'instructor') === 'string' ? [parameterExample('create_course', 'instructor')] : undefined,
                    nullable: true,
                }),
                tags: describedStringArraySchema(parameterDescription('create_course', 'tags', 'Optional tag array.'), {
                    example: parameterExample('create_course', 'tags'),
                }),
            },
            required: ['title'],
            additionalProperties: false,
            examples: [getSmeMcpToolMetadata('create_course').minimalExample.input, getSmeMcpToolMetadata('create_course').fullExample?.input].filter(Boolean),
        },
        execute: (user, input) => SmeMcpService.createCourse(user, input as z.infer<typeof createCourseSchema>),
    },
    {
        name: 'create_exam',
        description: smeMcpToolMetadataByName.create_exam.description,
        inputSchema: createExamSchema,
        inputJsonSchema: {
            type: 'object',
            description: toolInputDescription('create_exam'),
            properties: {
                title: describedStringSchema(parameterDescription('create_exam', 'title', 'Required exam title.'), {
                    minLength: 1,
                    maxLength: 200,
                    examples: [String(parameterExample('create_exam', 'title') ?? '')],
                }),
                event: describedStringSchema(parameterDescription('create_exam', 'event', 'Optional event reference.'), {
                    examples: typeof parameterExample('create_exam', 'event') === 'string' ? [parameterExample('create_exam', 'event')] : undefined,
                    nullable: true,
                }),
                description: describedStringSchema(parameterDescription('create_exam', 'description', 'Optional description.'), {
                    examples: typeof parameterExample('create_exam', 'description') === 'string' ? [parameterExample('create_exam', 'description')] : undefined,
                    nullable: true,
                }),
                instructions: describedStringSchema(parameterDescription('create_exam', 'instructions', 'Optional instructions.'), {
                    examples: typeof parameterExample('create_exam', 'instructions') === 'string' ? [parameterExample('create_exam', 'instructions')] : undefined,
                    nullable: true,
                }),
                examType: describedStringSchema(parameterDescription('create_exam', 'examType', 'Optional assessment kind.'), {
                    enum: parameterAcceptedValues('create_exam', 'examType'),
                    examples: typeof parameterExample('create_exam', 'examType') === 'string' ? [parameterExample('create_exam', 'examType')] : undefined,
                }),
                awardsStars: describedBooleanSchema(
                    parameterDescription('create_exam', 'awardsStars', 'Optional star-award flag; defaults to true.')
                ),
                starValue: describedIntegerSchema(
                    parameterDescription('create_exam', 'starValue', 'Stars awarded on pass; defaults to 3.'),
                    { minimum: 0, maximum: 20, examples: [3] }
                ),
                countsTowardPerformance: describedBooleanSchema(
                    parameterDescription('create_exam', 'countsTowardPerformance', 'Optional performance tracking flag; defaults to false.')
                ),
                totalScore: describedIntegerSchema(parameterDescription('create_exam', 'totalScore', 'Required total score.'), {
                    minimum: 1,
                    examples: [Number(parameterExample('create_exam', 'totalScore') ?? 100)],
                }),
                passingScore: describedIntegerSchema(parameterDescription('create_exam', 'passingScore', 'Required passing score.'), {
                    minimum: 0,
                    examples: [Number(parameterExample('create_exam', 'passingScore') ?? 80)],
                }),
                maxAttempts: describedIntegerSchema(parameterDescription('create_exam', 'maxAttempts', 'Required max attempts.'), {
                    minimum: 1,
                    examples: [Number(parameterExample('create_exam', 'maxAttempts') ?? 3)],
                }),
                options: describedObjectSchema(
                    parameterDescription('create_exam', 'options', 'Optional exam option overrides.'),
                    {
                        timeLimit: describedIntegerSchema('Optional time limit in minutes.', { minimum: 1 }),
                        randomizeQuestions: describedBooleanSchema('Optional randomize-questions flag.'),
                        randomizeOptions: describedBooleanSchema('Optional randomize-options flag.'),
                        showResultsImmediately: describedBooleanSchema('Optional show-results-immediately flag.'),
                        allowReview: describedBooleanSchema('Optional allow-review flag.'),
                    },
                    { example: parameterExample('create_exam', 'options') }
                ),
            },
            required: ['title', 'totalScore', 'passingScore', 'maxAttempts'],
            additionalProperties: false,
            examples: [getSmeMcpToolMetadata('create_exam').minimalExample.input, getSmeMcpToolMetadata('create_exam').fullExample?.input].filter(Boolean),
        },
        execute: (user, input) => SmeMcpService.createExam(user, input as z.infer<typeof createExamSchema>),
    },
    {
        name: 'attach_exam_to_event',
        description: smeMcpToolMetadataByName.attach_exam_to_event.description,
        inputSchema: attachExamToEventSchema,
        inputJsonSchema: {
            type: 'object',
            description: toolInputDescription('attach_exam_to_event'),
            properties: {
                exam: describedStringSchema(parameterDescription('attach_exam_to_event', 'exam', 'Required exam reference.'), {
                    minLength: 1,
                    maxLength: 200,
                    examples: [String(parameterExample('attach_exam_to_event', 'exam') ?? '')],
                }),
                event: describedStringSchema(parameterDescription('attach_exam_to_event', 'event', 'Required event reference.'), {
                    minLength: 1,
                    maxLength: 200,
                    examples: [String(parameterExample('attach_exam_to_event', 'event') ?? '')],
                }),
            },
            required: ['exam', 'event'],
            additionalProperties: false,
            examples: [getSmeMcpToolMetadata('attach_exam_to_event').minimalExample.input],
        },
        execute: (user, input) =>
            SmeMcpService.attachExamToEvent(user, input as z.infer<typeof attachExamToEventSchema>),
    },
    {
        name: 'design_course',
        description: smeMcpToolMetadataByName.design_course.description,
        inputSchema: designCourseSchema,
        inputJsonSchema: {
            type: 'object',
            description: toolInputDescription('design_course'),
            properties: {
                course: describedStringSchema(parameterDescription('design_course', 'course', 'Required course reference.'), {
                    minLength: 1,
                    maxLength: 200,
                    examples: [String(parameterExample('design_course', 'course') ?? '')],
                }),
                mode: describedStringSchema(parameterDescription('design_course', 'mode', 'Required design mode.'), {
                    enum: parameterAcceptedValues('design_course', 'mode'),
                    examples: typeof parameterExample('design_course', 'mode') === 'string' ? [parameterExample('design_course', 'mode')] : undefined,
                }),
                brief: describedStringSchema(parameterDescription('design_course', 'brief', 'Optional design brief.'), {
                    examples: typeof parameterExample('design_course', 'brief') === 'string' ? [parameterExample('design_course', 'brief')] : undefined,
                }),
                targetAudience: describedStringSchema(parameterDescription('design_course', 'targetAudience', 'Optional target audience.'), {
                    examples: typeof parameterExample('design_course', 'targetAudience') === 'string' ? [parameterExample('design_course', 'targetAudience')] : undefined,
                    nullable: true,
                }),
                lessonCount: describedIntegerSchema(parameterDescription('design_course', 'lessonCount', 'Optional lesson count.'), {
                    minimum: 1,
                    maximum: 12,
                    examples: typeof parameterExample('design_course', 'lessonCount') === 'number' ? [parameterExample('design_course', 'lessonCount')] : [3],
                }),
                chapters: {
                    type: 'array',
                    description: parameterDescription('design_course', 'chapters', 'Optional chapter outline.'),
                    items: {
                        type: 'object',
                        properties: {
                            title: { type: 'string' },
                            description: { type: ['string', 'null'] },
                            lessons: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    properties: {
                                        title: { type: 'string' },
                                        objective: { type: ['string', 'null'] },
                                        summary: { type: ['string', 'null'] },
                                    },
                                    required: ['title'],
                                    additionalProperties: false,
                                },
                            },
                        },
                        required: ['title', 'lessons'],
                        additionalProperties: false,
                    },
                    ...(Array.isArray(parameterExample('design_course', 'chapters')) ? { examples: [parameterExample('design_course', 'chapters')] } : {}),
                },
                assetPlan: {
                    type: 'array',
                    description: parameterDescription('design_course', 'assetPlan', 'Optional asset planning array.'),
                    items: {
                        type: 'object',
                        properties: {
                            lessonRef: { type: 'string' },
                            assetType: { type: 'string', enum: ['VIDEO', 'DOCUMENT', 'PRESENTATION', 'TEXT', 'AUDIO', 'WEB_PACKAGE', 'OTHER'] },
                            title: { type: 'string' },
                            sourceKind: { type: 'string', enum: ['upload', 'external_url', 's3_object'] },
                            sourceBucket: { type: 'string' },
                            sourceKey: { type: 'string' },
                            sourceRegion: { type: 'string' },
                            sourceContentType: { type: 'string' },
                            transcriptBucket: { type: 'string' },
                            transcriptKey: { type: 'string' },
                            transcriptRegion: { type: 'string' },
                            transcriptFormat: { type: 'string', enum: ['AUTO', 'TIMESTAMPED_TEXT', 'PLAIN_TEXT'] },
                            transcriptLanguage: { type: 'string' },
                            transcriptLabel: { type: ['string', 'null'] },
                            setTranscriptAsDefaultSubtitle: { type: 'boolean' },
                            setTranscriptAsPrimaryForAI: { type: 'boolean' },
                            processKnowledge: { type: 'boolean' },
                            transcriptNeeded: { type: 'boolean' },
                        },
                        required: ['lessonRef', 'assetType', 'title', 'sourceKind'],
                        additionalProperties: false,
                    },
                    ...(Array.isArray(parameterExample('design_course', 'assetPlan')) ? { examples: [parameterExample('design_course', 'assetPlan')] } : {}),
                },
                transcriptPlan: {
                    type: 'array',
                    description: parameterDescription('design_course', 'transcriptPlan', 'Optional transcript planning array.'),
                    items: {
                        type: 'object',
                        properties: {
                            lessonRef: { type: 'string' },
                            languageCode: { type: 'string' },
                            setAsDefaultSubtitle: { type: 'boolean' },
                            setAsPrimaryForAI: { type: 'boolean' },
                        },
                        required: ['lessonRef'],
                        additionalProperties: false,
                    },
                    ...(Array.isArray(parameterExample('design_course', 'transcriptPlan')) ? { examples: [parameterExample('design_course', 'transcriptPlan')] } : {}),
                },
            },
            required: ['course', 'mode'],
            additionalProperties: false,
            examples: [getSmeMcpToolMetadata('design_course').minimalExample.input, getSmeMcpToolMetadata('design_course').fullExample?.input].filter(Boolean),
        },
        execute: (user, input) => SmeMcpService.designCourse(user, input as z.infer<typeof designCourseSchema>),
    },
    {
        name: 'design_exam_questions',
        description: smeMcpToolMetadataByName.design_exam_questions.description,
        inputSchema: designExamQuestionsSchema,
        inputJsonSchema: {
            type: 'object',
            description: toolInputDescription('design_exam_questions'),
            properties: {
                exam: describedStringSchema(parameterDescription('design_exam_questions', 'exam', 'Required exam reference.'), {
                    minLength: 1,
                    maxLength: 200,
                    examples: [String(parameterExample('design_exam_questions', 'exam') ?? '')],
                }),
                mode: describedStringSchema(parameterDescription('design_exam_questions', 'mode', 'Required design mode.'), {
                    enum: parameterAcceptedValues('design_exam_questions', 'mode'),
                    examples: typeof parameterExample('design_exam_questions', 'mode') === 'string' ? [parameterExample('design_exam_questions', 'mode')] : undefined,
                }),
                sourceCourse: describedStringSchema(parameterDescription('design_exam_questions', 'sourceCourse', 'Optional source course reference.'), {
                    examples: typeof parameterExample('design_exam_questions', 'sourceCourse') === 'string' ? [parameterExample('design_exam_questions', 'sourceCourse')] : undefined,
                    nullable: true,
                }),
                sourceEvent: describedStringSchema(parameterDescription('design_exam_questions', 'sourceEvent', 'Optional source event reference.'), {
                    examples: typeof parameterExample('design_exam_questions', 'sourceEvent') === 'string' ? [parameterExample('design_exam_questions', 'sourceEvent')] : undefined,
                    nullable: true,
                }),
                questionCount: describedIntegerSchema(parameterDescription('design_exam_questions', 'questionCount', 'Optional question count.'), {
                    minimum: 1,
                    maximum: 100,
                    examples: typeof parameterExample('design_exam_questions', 'questionCount') === 'number' ? [parameterExample('design_exam_questions', 'questionCount')] : [10],
                }),
                difficultyMix: describedStringSchema(parameterDescription('design_exam_questions', 'difficultyMix', 'Optional difficulty mix.'), {
                    enum: parameterAcceptedValues('design_exam_questions', 'difficultyMix'),
                    examples: typeof parameterExample('design_exam_questions', 'difficultyMix') === 'string' ? [parameterExample('design_exam_questions', 'difficultyMix')] : undefined,
                }),
                questionTypes: {
                    type: 'array',
                    description: parameterDescription('design_exam_questions', 'questionTypes', 'Optional question type array.'),
                    items: {
                        type: 'string',
                        enum: ['SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'TRUE_FALSE', 'FILL_IN_BLANK', 'ESSAY', 'EXERCISE'],
                    },
                    ...(Array.isArray(parameterExample('design_exam_questions', 'questionTypes')) ? { examples: [parameterExample('design_exam_questions', 'questionTypes')] } : {}),
                },
                choiceOptionCount: {
                    type: 'integer',
                    description: 'Number of answer options for generated SINGLE_CHOICE and MULTIPLE_CHOICE questions.',
                    enum: [4, 5, 6],
                    default: 4,
                    examples: [6],
                },
                coverageNotes: describedStringSchema(parameterDescription('design_exam_questions', 'coverageNotes', 'Optional coverage notes.'), {
                    examples: typeof parameterExample('design_exam_questions', 'coverageNotes') === 'string' ? [parameterExample('design_exam_questions', 'coverageNotes')] : undefined,
                    nullable: true,
                }),
                generateEssayScoringCriteria: describedBooleanSchema(
                    parameterDescription('design_exam_questions', 'generateEssayScoringCriteria', 'Optional essay scoring-point generation flag.'),
                    true
                ),
                essayScoringStyle: describedStringSchema(parameterDescription('design_exam_questions', 'essayScoringStyle', 'Optional essay scoring style.'), {
                    enum: parameterAcceptedValues('design_exam_questions', 'essayScoringStyle'),
                    examples: typeof parameterExample('design_exam_questions', 'essayScoringStyle') === 'string' ? [parameterExample('design_exam_questions', 'essayScoringStyle')] : undefined,
                }),
                requireEssayAiReady: describedBooleanSchema(
                    parameterDescription('design_exam_questions', 'requireEssayAiReady', 'Optional strict essay AI-readiness flag.'),
                    false
                ),
                questions: {
                    type: 'array',
                    description: parameterDescription('design_exam_questions', 'questions', 'Optional manual question payload.'),
                    items: {
                        type: 'object',
                        properties: {
                            type: { type: 'string', enum: ['SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'TRUE_FALSE', 'FILL_IN_BLANK', 'ESSAY', 'EXERCISE'] },
                            difficulty: { type: 'string', enum: ['EASY', 'MEDIUM', 'HARD'] },
                            question: { type: 'string' },
                            options: { type: 'array', minItems: 2, maxItems: 6, items: { type: 'string' } },
                            correctAnswer: {
                                anyOf: [
                                    { type: 'string' },
                                    { type: 'number' },
                                    { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
                                ],
                                description: 'For SINGLE_CHOICE, use A-F, a 0-based index, or exact option text; the MCP normalizes it to an option index. For MULTIPLE_CHOICE, use comma-separated letters/indexes/text or an array.',
                            },
                            rubric: { type: 'string' },
                            sampleAnswer: { type: 'string' },
                            gradingCriteria: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    properties: {
                                        id: { type: 'string' },
                                        title: { type: 'string' },
                                        description: { type: ['string', 'null'] },
                                        maxPoints: { type: 'integer' },
                                        guidance: { type: ['string', 'null'] },
                                        required: { type: 'boolean' },
                                    },
                                    required: ['title', 'maxPoints'],
                                    additionalProperties: false,
                                },
                            },
                            maxWords: { type: 'integer' },
                            points: { type: 'integer' },
                            explanation: { type: 'string' },
                            topic: { type: 'string' },
                            tags: { type: 'array', items: { type: 'string' } },
                        },
                        required: ['type', 'question'],
                        additionalProperties: false,
                    },
                    ...(Array.isArray(parameterExample('design_exam_questions', 'questions')) ? { examples: [parameterExample('design_exam_questions', 'questions')] } : {}),
                },
            },
            required: ['exam', 'mode'],
            additionalProperties: false,
            examples: [getSmeMcpToolMetadata('design_exam_questions').minimalExample.input, getSmeMcpToolMetadata('design_exam_questions').fullExample?.input].filter(Boolean),
        },
        execute: (user, input) =>
            SmeMcpService.designExamQuestions(user, input as z.infer<typeof designExamQuestionsSchema>),
    },
    {
        name: 'review_event_status',
        description: smeMcpToolMetadataByName.review_event_status.description,
        inputSchema: reviewEventStatusSchema,
        inputJsonSchema: {
            type: 'object',
            description: toolInputDescription('review_event_status'),
            properties: {
                event: describedStringSchema(parameterDescription('review_event_status', 'event', 'Required event reference.'), {
                    minLength: 1,
                    maxLength: 200,
                    examples: [String(parameterExample('review_event_status', 'event') ?? '')],
                }),
            },
            required: ['event'],
            additionalProperties: false,
            examples: [getSmeMcpToolMetadata('review_event_status').minimalExample.input],
        },
        execute: (user, input) =>
            SmeMcpService.reviewEventStatus(user, input as z.infer<typeof reviewEventStatusSchema>),
    },
    {
        name: 'share_course_with_learners',
        description: smeMcpToolMetadataByName.share_course_with_learners.description,
        inputSchema: shareCourseWithLearnersSchema,
        inputJsonSchema: {
            type: 'object',
            description: toolInputDescription('share_course_with_learners'),
            properties: {
                course: describedStringSchema(parameterDescription('share_course_with_learners', 'course', 'Required course reference.'), {
                    minLength: 1,
                    maxLength: 200,
                    examples: [String(parameterExample('share_course_with_learners', 'course') ?? '')],
                }),
                userIds: describedUuidArraySchema(
                    parameterDescription('share_course_with_learners', 'userIds', 'Required learner UUID list.'),
                    { minItems: 1, example: parameterExample('share_course_with_learners', 'userIds') }
                ),
                sendNotification: describedBooleanSchema(
                    parameterDescription(
                        'share_course_with_learners',
                        'sendNotification',
                        'Optional send-notification flag.'
                    ),
                    false
                ),
                ...highRiskControlJsonProperties,
            },
            required: ['course', 'userIds'],
            additionalProperties: false,
            examples: [
                getSmeMcpToolMetadata('share_course_with_learners').minimalExample.input,
                getSmeMcpToolMetadata('share_course_with_learners').fullExample?.input,
            ].filter(Boolean),
        },
        execute: (user, input) =>
            SmeMcpService.shareCourseWithLearners(user, input as z.infer<typeof shareCourseWithLearnersSchema>),
    },
    {
        name: 'publish_exam_for_learners',
        description: smeMcpToolMetadataByName.publish_exam_for_learners.description,
        inputSchema: publishExamForLearnersSchema,
        inputJsonSchema: {
            type: 'object',
            description: toolInputDescription('publish_exam_for_learners'),
            properties: {
                exam: describedStringSchema(parameterDescription('publish_exam_for_learners', 'exam', 'Required exam reference.'), {
                    minLength: 1,
                    maxLength: 200,
                    examples: [String(parameterExample('publish_exam_for_learners', 'exam') ?? '')],
                }),
                userIds: describedUuidArraySchema(
                    parameterDescription('publish_exam_for_learners', 'userIds', 'Optional learner UUID list.'),
                    { example: parameterExample('publish_exam_for_learners', 'userIds') }
                ),
                sendNotification: describedBooleanSchema(
                    parameterDescription(
                        'publish_exam_for_learners',
                        'sendNotification',
                        'Optional send-notification flag.'
                    ),
                    false
                ),
                ...highRiskControlJsonProperties,
            },
            required: ['exam'],
            additionalProperties: false,
            examples: [
                getSmeMcpToolMetadata('publish_exam_for_learners').minimalExample.input,
                getSmeMcpToolMetadata('publish_exam_for_learners').fullExample?.input,
            ].filter(Boolean),
        },
        execute: (user, input) =>
            SmeMcpService.publishExamForLearners(user, input as z.infer<typeof publishExamForLearnersSchema>),
    },
    {
        name: 'prepare_transcript_upload',
        description: smeMcpToolMetadataByName.prepare_transcript_upload.description,
        inputSchema: prepareTranscriptUploadSchema,
        inputJsonSchema: {
            type: 'object',
            description: toolInputDescription('prepare_transcript_upload'),
            properties: {
                lessonId: describedUuidSchema(
                    parameterDescription('prepare_transcript_upload', 'lessonId', 'Required lesson UUID.'),
                    parameterExample('prepare_transcript_upload', 'lessonId')
                ),
                videoAssetId: describedUuidSchema(
                    parameterDescription('prepare_transcript_upload', 'videoAssetId', 'Optional video asset UUID.'),
                    parameterExample('prepare_transcript_upload', 'videoAssetId')
                ),
                filename: describedStringSchema(
                    parameterDescription('prepare_transcript_upload', 'filename', 'Required filename.'),
                    { minLength: 1, maxLength: 255, examples: [parameterExample('prepare_transcript_upload', 'filename') ?? ''] }
                ),
                contentType: describedStringSchema(
                    parameterDescription('prepare_transcript_upload', 'contentType', 'Optional content type.'),
                    {
                        enum: (parameterAcceptedValues('prepare_transcript_upload', 'contentType') ?? ['text/vtt']) as readonly string[],
                        examples: [parameterExample('prepare_transcript_upload', 'contentType') ?? 'text/vtt'],
                    }
                ),
                languageCode: describedStringSchema(
                    parameterDescription('prepare_transcript_upload', 'languageCode', 'Optional language code.'),
                    { minLength: 2, maxLength: 20, examples: [parameterExample('prepare_transcript_upload', 'languageCode') ?? ''] }
                ),
                label: describedStringSchema(
                    parameterDescription('prepare_transcript_upload', 'label', 'Optional label.'),
                    { maxLength: 80, nullable: true, examples: [parameterExample('prepare_transcript_upload', 'label') ?? ''] }
                ),
                replaceExistingLanguage: describedBooleanSchema(
                    parameterDescription(
                        'prepare_transcript_upload',
                        'replaceExistingLanguage',
                        'Optional replace-existing-language flag.'
                    )
                ),
                setAsDefaultSubtitle: describedBooleanSchema(
                    parameterDescription(
                        'prepare_transcript_upload',
                        'setAsDefaultSubtitle',
                        'Optional default-subtitle flag.'
                    )
                ),
                setAsPrimaryForAI: describedBooleanSchema(
                    parameterDescription('prepare_transcript_upload', 'setAsPrimaryForAI', 'Optional primary-for-AI flag.')
                ),
                ...highRiskControlJsonProperties,
            },
            required: ['lessonId', 'filename'],
            additionalProperties: false,
            examples: [
                {
                    lessonId: parameterExample('prepare_transcript_upload', 'lessonId'),
                    filename: parameterExample('prepare_transcript_upload', 'filename'),
                    contentType: parameterExample('prepare_transcript_upload', 'contentType'),
                    languageCode: parameterExample('prepare_transcript_upload', 'languageCode'),
                    label: parameterExample('prepare_transcript_upload', 'label'),
                    setAsDefaultSubtitle: true,
                    setAsPrimaryForAI: true,
                },
                {
                    lessonId: parameterExample('prepare_transcript_upload', 'lessonId'),
                    videoAssetId: parameterExample('prepare_transcript_upload', 'videoAssetId'),
                    filename: parameterExample('prepare_transcript_upload', 'filename'),
                    contentType: parameterExample('prepare_transcript_upload', 'contentType'),
                },
            ],
        },
        execute: (user, input) =>
            SmeMcpService.prepareTranscriptUpload(user, input as z.infer<typeof prepareTranscriptUploadSchema>),
    },
    {
        name: 'process_transcript_knowledge',
        description: smeMcpToolMetadataByName.process_transcript_knowledge.description,
        inputSchema: processTranscriptKnowledgeSchema,
        inputJsonSchema: {
            type: 'object',
            description: toolInputDescription('process_transcript_knowledge'),
            properties: {
                lessonId: describedUuidSchema(
                    parameterDescription('process_transcript_knowledge', 'lessonId', 'Required lesson UUID.'),
                    parameterExample('process_transcript_knowledge', 'lessonId')
                ),
                transcriptId: describedUuidSchema(
                    parameterDescription('process_transcript_knowledge', 'transcriptId', 'Optional transcript UUID.'),
                    parameterExample('process_transcript_knowledge', 'transcriptId')
                ),
                processTranscript: describedBooleanSchema(
                    parameterDescription(
                        'process_transcript_knowledge',
                        'processTranscript',
                        'Optional process-transcript flag.'
                    )
                ),
                processKnowledge: describedBooleanSchema(
                    parameterDescription(
                        'process_transcript_knowledge',
                        'processKnowledge',
                        'Optional process-knowledge flag.'
                    )
                ),
                force: describedBooleanSchema(
                    parameterDescription('process_transcript_knowledge', 'force', 'Optional force flag.')
                ),
                knowledgePromptTemplateId: describedUuidSchema(
                    parameterDescription(
                        'process_transcript_knowledge',
                        'knowledgePromptTemplateId',
                        'Optional knowledge prompt template UUID.'
                    )
                ),
                ...highRiskControlJsonProperties,
            },
            required: ['lessonId'],
            additionalProperties: false,
            examples: [
                {
                    lessonId: parameterExample('process_transcript_knowledge', 'lessonId'),
                    processTranscript: true,
                    processKnowledge: true,
                },
                {
                    lessonId: parameterExample('process_transcript_knowledge', 'lessonId'),
                    transcriptId: parameterExample('process_transcript_knowledge', 'transcriptId'),
                    processKnowledge: true,
                    force: true,
                },
            ],
        },
        execute: (user, input) =>
            SmeMcpService.processTranscriptKnowledge(user, input as z.infer<typeof processTranscriptKnowledgeSchema>),
    },
    {
        name: 'list_my_series_badges',
        description: smeMcpToolMetadataByName.list_my_series_badges.description,
        inputSchema: z.object({}).default({}),
        inputJsonSchema: emptyObjectJsonSchema,
        execute: (user) => SmeMcpService.listMySeriesBadges(user),
    },
] as const satisfies readonly SmeMcpToolDefinition[]

export type ActiveSmeMcpToolName = (typeof smeMcpToolDefinitions)[number]['name']

const toolDefinitionMap = new Map<string, SmeMcpToolDefinition>(
    smeMcpToolDefinitions.map((definition) => [definition.name, definition])
)

export const activeSmeMcpToolNames = smeMcpToolDefinitions.map((definition) => definition.name) as ActiveSmeMcpToolName[]

export const getSmeMcpToolDefinition = (toolName: string) => toolDefinitionMap.get(toolName)

export const isSmeMcpToolExposedOnStandardServer = (toolName: string) =>
    toolDefinitionMap.has(toolName) && isToolExposedOnStandardMcpServer(toolName)

export const listMcpToolsForServer = () =>
    smeMcpToolDefinitions
        .filter((definition) => isToolExposedOnStandardMcpServer(definition.name))
        .map((definition) => ({
        name: definition.name,
        description: definition.description,
        inputSchema: definition.inputJsonSchema,
        annotations: getSmeMcpToolAnnotations(definition.name),
    }))
