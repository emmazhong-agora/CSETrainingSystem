import {
    LessonAssetType,
    ExamQuestionType,
    DifficultyLevel,
    ExamStatus,
    AssessmentKind,
} from '@prisma/client'
import { z } from 'zod'
import { LessonCompletionRule, LessonType } from '@prisma/client'
import { DEFAULT_EXAM_TIMEZONE, isValidExamTimeZone } from '@/lib/exam-timezone'
import { slugifyCriterionTitle } from '@/lib/essay-grading'
import { LEARNING_EVENT_FORMATS, LEARNING_SERIES_TYPES } from '@/lib/training-ops-series-event-rules'

// User schemas
export const registerSchema = z.object({
    email: z.string().email('Invalid email address'),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    name: z.string().min(1, 'Name is required'),
    department: z.string().optional(),
})

export const loginSchema = z.object({
    email: z.string().email('Invalid email address'),
    password: z.string().min(1, 'Password is required'),
})

export const updateProfileSchema = z.object({
    name: z.string().min(1, 'Name is required').max(100, 'Name is too long'),
    title: z.string().max(120, 'Title is too long').optional().nullable(),
    department: z.string().max(120, 'Department is too long').optional().nullable(),
    bio: z.string().max(500, 'Bio is too long').optional().nullable(),
    avatar: z.string().url('Avatar must be a valid URL').optional().nullable(),
})

export const adminUpdateUserSchema = z.object({
    role: z.enum(['USER', 'SME', 'ADMIN']).optional(),
    status: z.enum(['ACTIVE', 'SUSPENDED', 'DELETED']).optional(),
    name: z.string().trim().min(1, 'Name is required').max(100, 'Name is too long').optional(),
    email: z.string().trim().email('Invalid email address').optional(),
    wecomUserId: z.string().trim().min(1, 'WeCom User ID is required').max(128, 'WeCom User ID is too long').optional(),
    department: z.string().trim().max(120, 'Department is too long').optional().nullable(),
    title: z.string().trim().max(120, 'Title is too long').optional().nullable(),
    domainIds: z.array(z.string().uuid()).optional(),
}).refine(
    data =>
        data.role !== undefined ||
        data.status !== undefined ||
        data.name !== undefined ||
        data.email !== undefined ||
        data.wecomUserId !== undefined ||
        data.department !== undefined ||
        data.title !== undefined ||
        data.domainIds !== undefined,
    {
        message: 'At least one field must be provided',
        path: ['role'],
    }
)

export const adminCreateUserSchema = z.object({
    email: z.string().trim().email('Invalid email address'),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    name: z.string().trim().min(1, 'Name is required').max(100, 'Name is too long'),
    wecomUserId: z.string().trim().min(1, 'WeCom User ID is required').max(128, 'WeCom User ID is too long'),
    department: z.string().trim().max(120, 'Department is too long').optional(),
    title: z.string().trim().max(120, 'Title is too long').optional(),
})

export const changePasswordSchema = z.object({
    currentPassword: z.string().min(1, 'Current password is required').optional(),
    newPassword: z.string().min(8, 'Password must be at least 8 characters'),
})

export const adminResetUserPasswordSchema = z.object({
    newPassword: z.string().min(8, 'Password must be at least 8 characters'),
})

const optionalNullableDateInput = () =>
    z.preprocess(
        (value) => {
            if (value === undefined || value === null || value === '') return null
            return value
        },
        z.coerce.date().nullable().optional()
    )

const productDomainCategories = ['RTE', 'AI'] as const
const productTracks = ['AGILE', 'MASTERY', 'RELEASE', 'FINAL'] as const
const smeKpiModes = ['DELTA', 'RETENTION', 'READINESS'] as const
const learningEventStatuses = ['IN_PROGRESS', 'COMPLETED'] as const
const assessmentKinds = ['PRACTICE', 'READINESS', 'FORMAL'] as const

export const createLearningEventSchema = z.object({
    title: z.string().trim().min(1, 'Title is required').max(200, 'Title is too long'),
    format: z.enum(LEARNING_EVENT_FORMATS),
    status: z.enum(learningEventStatuses).default('IN_PROGRESS'),
    seriesId: z.string().uuid().optional().nullable(),
    domainId: z.string().uuid().optional().nullable(),
    description: z.string().trim().optional().nullable(),
    scheduledAt: optionalNullableDateInput(),
    isRequired: z.boolean().default(false),
    countsTowardPerformance: z.boolean().default(false),
    hostId: z.string().uuid().optional().nullable(),
})

export const updateLearningEventSchema = createLearningEventSchema.partial().refine(
    (data) => Object.keys(data).length > 0,
    {
        message: 'At least one field must be provided',
        path: ['title'],
    }
)

const productDomainSchemaBase = z.object({
    name: z.string().trim().min(1, 'Name is required').max(120, 'Name is too long'),
    slug: z.string().trim().min(1, 'Slug is required').regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
    category: z.enum(productDomainCategories),
    track: z.enum(productTracks),
    kpiMode: z.enum(smeKpiModes),
    description: z.string().trim().optional().nullable(),
    cadence: z.string().trim().max(120, 'Cadence is too long').optional().nullable(),
    active: z.boolean().default(true),
    baselinePassRate: z.number().min(0).max(100).optional().nullable(),
    targetPassRate: z.number().min(0).max(100).optional().nullable(),
    challengeThreshold: z.number().min(0).max(100).optional().nullable(),
    primarySmeId: z.string().uuid().optional().nullable(),
    backupSmeId: z.string().uuid().optional().nullable(),
})

export const createProductDomainSchema = productDomainSchemaBase.refine((data) => !data.primarySmeId || !data.backupSmeId || data.primarySmeId !== data.backupSmeId, {
    message: 'Primary SME and backup SME must be different users',
    path: ['backupSmeId'],
})

export const updateProductDomainSchema = productDomainSchemaBase.partial().refine(
    (data) => Object.keys(data).length > 0,
    {
        message: 'At least one field must be provided',
        path: ['name'],
    }
)

const learningSeriesSchemaBase = z.object({
    name: z.string().trim().min(1, 'Name is required').max(160, 'Name is too long'),
    slug: z.string().trim().min(1, 'Slug is required').regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
    type: z.enum(LEARNING_SERIES_TYPES),
    domainId: z.string().uuid().optional().nullable(),
    description: z.string().trim().optional().nullable(),
    cadence: z.string().trim().max(120, 'Cadence is too long').optional().nullable(),
    isActive: z.boolean().default(true),
    countsTowardPerformance: z.boolean().default(false),
    defaultStarValue: z.number().int().min(0).max(20).optional().nullable(),
    ownerId: z.string().uuid().optional().nullable(),
})

export const createLearningSeriesSchema = learningSeriesSchemaBase

export const updateLearningSeriesSchema = learningSeriesSchemaBase.partial().refine(
    (data) => Object.keys(data).length > 0,
    {
        message: 'At least one field must be provided',
        path: ['name'],
    }
)

const badgeMilestoneSchemaShape = {
    name: z.string().trim().min(1, 'Name is required').max(120, 'Name is too long'),
    slug: z.string().trim().min(1, 'Slug is required').regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
    description: z.string().trim().optional().nullable(),
    icon: z.string().trim().max(32, 'Icon is too long').optional().nullable(),
    thresholdStars: z.number().int().min(1).max(1000),
    active: z.boolean().default(true),
    domainId: z.string().uuid('Select a valid product domain'),
}

const badgeMilestoneSchemaBase = z.object(badgeMilestoneSchemaShape)

export const createBadgeMilestoneSchema = badgeMilestoneSchemaBase

export const updateBadgeMilestoneSchema = badgeMilestoneSchemaBase.partial().refine(
    (data) => Object.keys(data).length > 0,
    {
        message: 'At least one field must be provided',
        path: ['name'],
    }
)

// Course schemas
export const createCourseSchema = z.object({
    title: z.string().min(1, 'Title is required'),
    slug: z.string().min(1, 'Slug is required').regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
    description: z.string().min(1, 'Description is required'),
    thumbnail: z.string().url().optional(),
    level: z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED']),
    category: z.string().min(1, 'Category is required'),
    tags: z.array(z.string()),
    learningOutcomes: z.array(z.string()).optional(),
    requirements: z.array(z.string()).optional(),
    instructorId: z.string().uuid(),
    learningEventId: z.string().uuid().optional().nullable(),
    status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional(),
})

export const updateCourseSchema = createCourseSchema.partial()

export const createCourseAssetSchema = z.object({
    title: z.string().min(1, 'Title is required'),
    description: z.string().optional(),
    url: z.string().url('Asset URL is invalid'),
    s3Key: z.string().min(1, 'S3 key is required'),
    contentType: z.string().optional(),
    type: z.nativeEnum(LessonAssetType),
})

// Chapter & Lesson
export const createChapterSchema = z.object({
    title: z.string().min(1, 'Title is required'),
    description: z.string().optional(),
    order: z.number().int().optional(),
})

export const updateChapterSchema = createChapterSchema.partial()

export const reorderChaptersSchema = z.object({
    chapterOrder: z.array(z.string().uuid()).nonempty(),
})

export const createLessonSchema = z.object({
    title: z.string().min(1, 'Title is required'),
    description: z.string().optional(),
    durationMinutes: z.number().int().positive().optional(),
    lessonType: z.nativeEnum(LessonType).optional(),
    learningObjectives: z.array(z.string()).optional(),
    completionRule: z.nativeEnum(LessonCompletionRule).optional(),
    order: z.number().int().optional(),
    courseAssetIds: z.array(z.string().min(1)).optional(),
})

export const updateLessonSchema = createLessonSchema.partial()

export const reorderLessonsSchema = z.object({
    lessonOrder: z.array(z.string().uuid()).nonempty(),
})

export const replaceLessonAssetsSchema = z.object({
    courseAssetIds: z.array(z.string().min(1)).default([]),
})

// Progress schemas
export const updateProgressSchema = z.object({
    watchedDuration: z.number().nonnegative(),
    lastTimestamp: z.number().nonnegative(),
    completed: z.boolean().optional(),
})

// Quiz schemas
export const submitQuizSchema = z.object({
    attemptId: z.string().uuid(),
    answers: z.record(z.string(), z.union([z.string(), z.number()])),
})

// AI schemas
export const aiMessageSchema = z.object({
    message: z.string().min(1, 'Message is required'),
    videoTimestamp: z.number().nonnegative().optional(),
    context: z.any().optional(),
})

// File upload schemas
export const presignedUrlSchema = z.object({
    filename: z.string().min(1, 'Filename is required'),
    contentType: z.string().regex(/^video\//, 'Must be a video file'),
    lessonId: z.string().uuid().optional(),
})

export const confirmUploadSchema = z.object({
    key: z.string().min(1, 'S3 key is required'),
    lessonId: z.string().uuid(),
})

// Helper function to validate request body
export function validateRequestBody<T>(schema: z.ZodSchema<T>, data: unknown): T {
    return schema.parse(data)
}

// ============================================================================
// EXAM SCHEMAS
// ============================================================================

const optionalLocalDateTimeInput = () =>
    z.preprocess(
        (value) => {
            if (value === undefined || value === null) return undefined
            if (typeof value === 'string') {
                const trimmed = value.trim()
                if (!trimmed) return undefined
                return trimmed
            }
            return value
        },
        z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/).optional()
    )

const optionalNullableLocalDateTimeInput = () =>
    z.preprocess(
        (value) => {
            if (value === undefined) return undefined
            if (value === null) return null
            if (typeof value === 'string') {
                const trimmed = value.trim()
                if (!trimmed) return null
                return trimmed
            }
            return value
        },
        z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/).nullable().optional()
    )

const examTimeZoneInput = () =>
    z
        .string()
        .trim()
        .min(1, 'Timezone is required')
        .refine(isValidExamTimeZone, 'Timezone must be a valid IANA timezone')

export const createExamSchema = z.object({
    courseId: z.string().uuid().optional().nullable(),
    title: z.string().min(1, 'Title is required').max(200),
    description: z.string().optional(),
    instructions: z.string().optional(),
    timeLimit: z.number().int().positive().optional(),
    timezone: examTimeZoneInput().default(DEFAULT_EXAM_TIMEZONE),
    deadline: optionalLocalDateTimeInput(),
    availableFrom: optionalLocalDateTimeInput(),
    totalScore: z.number().int().positive().default(100),
    passingScore: z.number().int().min(0).max(100).default(70),
    randomizeQuestions: z.boolean().default(false),
    randomizeOptions: z.boolean().default(false),
    showResultsImmediately: z.boolean().default(true),
    allowReview: z.boolean().default(true),
    maxAttempts: z.number().int().positive().default(1),
    assessmentKind: z.enum(assessmentKinds).default('PRACTICE'),
    productDomainId: z.string().uuid().optional().nullable(),
    learningSeriesId: z.string().uuid().optional().nullable(),
    learningEventId: z.string().uuid().optional().nullable(),
    awardsStars: z.boolean().default(true),
    starValue: z.number().int().min(0).max(20).default(3),
    countsTowardPerformance: z.boolean().default(false),
})

export const updateExamSchema = z.object({
    courseId: z.string().uuid().optional().nullable(),
    learningEventId: z.string().uuid().optional().nullable(),
    title: z.string().min(1, 'Title is required').max(200, 'Title is too long').optional(),
    description: z.string().optional().nullable(),
    instructions: z.string().optional().nullable(),
    timeLimit: z.number().int().positive().optional().nullable(),
    timezone: examTimeZoneInput().optional(),
    deadline: optionalNullableLocalDateTimeInput(),
    availableFrom: optionalNullableLocalDateTimeInput(),
    totalScore: z.number().int().positive().optional(),
    passingScore: z.number().int().min(0).max(100).optional(),
    randomizeQuestions: z.boolean().optional(),
    randomizeOptions: z.boolean().optional(),
    showResultsImmediately: z.boolean().optional(),
    allowReview: z.boolean().optional(),
    maxAttempts: z.number().int().positive().optional(),
    assessmentKind: z.nativeEnum(AssessmentKind).optional(),
    awardsStars: z.boolean().optional(),
    starValue: z.number().int().min(0).max(20).optional().nullable(),
    countsTowardPerformance: z.boolean().optional(),
}).refine(
    (data) => Object.keys(data).length > 0,
    {
        message: 'At least one field must be provided',
        path: ['title'],
    }
)

export const changeExamStatusSchema = z.object({
    status: z.nativeEnum(ExamStatus),
})

const examQuestionSchemaBase = z.object({
    type: z.nativeEnum(ExamQuestionType),
    difficulty: z.nativeEnum(DifficultyLevel).default(DifficultyLevel.MEDIUM),
    question: z.string().min(1, 'Question text is required'),
    options: z.array(z.string().trim().min(1, 'Option text is required')).min(2).max(6).optional(),
    correctAnswer: z.string().optional(),
    rubric: z.string().optional(),
    sampleAnswer: z.string().optional(),
    gradingCriteria: z.array(
        z.object({
            id: z.string().trim().min(1).optional(),
            title: z.string().trim().min(1, 'Criterion title is required'),
            description: z.string().trim().optional().nullable(),
            maxPoints: z.number().positive('Criterion max points must be greater than 0'),
            guidance: z.string().trim().optional().nullable(),
            required: z.boolean().optional(),
        }).transform((criterion) => ({
            id: criterion.id?.trim() || slugifyCriterionTitle(criterion.title),
            title: criterion.title.trim(),
            description: criterion.description?.trim() || null,
            maxPoints: criterion.maxPoints,
            guidance: criterion.guidance?.trim() || null,
            required: criterion.required ?? false,
        }))
    ).optional().nullable(),
    maxWords: z.number().int().positive().optional(),
    attachmentS3Key: z.string().nullable().optional(),
    attachmentFilename: z.string().nullable().optional(),
    attachmentMimeType: z.string().nullable().optional(),
    points: z.number().int().positive().default(10),
    explanation: z.string().optional(),
    topic: z.string().optional(),
    tags: z.array(z.string()).default([]),
})

const refineExerciseQuestionFields = (
    data: z.infer<typeof examQuestionSchemaBase> | Partial<z.infer<typeof examQuestionSchemaBase>>,
    ctx: z.RefinementCtx
) => {
    if (data.type !== ExamQuestionType.EXERCISE) return

    if (Array.isArray(data.options) && data.options.some((o) => o.trim())) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Exercise questions do not support options',
            path: ['options'],
        })
    }
    if (typeof data.correctAnswer === 'string' && data.correctAnswer.trim()) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Exercise questions do not have a correctAnswer',
            path: ['correctAnswer'],
        })
    }
    if (typeof data.rubric === 'string' && data.rubric.trim()) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Exercise questions do not support rubric',
            path: ['rubric'],
        })
    }
    if (typeof data.sampleAnswer === 'string' && data.sampleAnswer.trim()) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Exercise questions do not support sampleAnswer',
            path: ['sampleAnswer'],
        })
    }
    if (typeof data.maxWords === 'number') {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Exercise questions do not support maxWords',
            path: ['maxWords'],
        })
    }
    if (Array.isArray(data.gradingCriteria) && data.gradingCriteria.length > 0) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Exercise questions do not support grading criteria',
            path: ['gradingCriteria'],
        })
    }

    if (typeof data.attachmentS3Key === 'string' && data.attachmentS3Key.trim()) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Exercise questions do not support attachments',
            path: ['attachmentS3Key'],
        })
    }
}

const refineEssayAttachmentFields = (
    data: z.infer<typeof examQuestionSchemaBase> | Partial<z.infer<typeof examQuestionSchemaBase>>,
    ctx: z.RefinementCtx
) => {
    const attachmentFields = [data.attachmentS3Key, data.attachmentFilename, data.attachmentMimeType]
    const attachmentCount = attachmentFields.filter((value) => typeof value === 'string' && value.trim().length > 0).length

    if (attachmentCount === 0) return

    if (data.type !== ExamQuestionType.ESSAY) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Only essay questions support document attachments',
            path: ['attachmentS3Key'],
        })
        return
    }

    if (attachmentCount !== 3) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Attachment metadata is incomplete',
            path: ['attachmentS3Key'],
        })
    }
}

const refineEssayGradingCriteria = (
    data: z.infer<typeof examQuestionSchemaBase> | Partial<z.infer<typeof examQuestionSchemaBase>>,
    ctx: z.RefinementCtx
) => {
    const criteria = Array.isArray(data.gradingCriteria) ? data.gradingCriteria : []

    if (criteria.length > 0 && data.type !== ExamQuestionType.ESSAY) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Only essay questions support grading criteria',
            path: ['gradingCriteria'],
        })
        return
    }

    if (data.type !== ExamQuestionType.ESSAY || criteria.length === 0) return

    const totalCriterionPoints = criteria.reduce((sum, criterion) => sum + criterion.maxPoints, 0)
    if (typeof data.points === 'number' && totalCriterionPoints !== data.points) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'The sum of grading criteria points must match the question points',
            path: ['gradingCriteria'],
        })
    }

    const ids = new Set<string>()
    criteria.forEach((criterion, index) => {
        if (ids.has(criterion.id)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Each grading criterion must have a unique ID',
                path: ['gradingCriteria', index, 'id'],
            })
            return
        }
        ids.add(criterion.id)
    })
}

export const createExamQuestionSchema = examQuestionSchemaBase
    .superRefine(refineExerciseQuestionFields)
    .superRefine(refineEssayAttachmentFields)
    .superRefine(refineEssayGradingCriteria)
export const updateExamQuestionSchema = examQuestionSchemaBase
    .partial()
    .superRefine(refineExerciseQuestionFields)
    .superRefine(refineEssayAttachmentFields)
    .superRefine(refineEssayGradingCriteria)

export const reorderExamQuestionsSchema = z.object({
    questionIds: z.array(z.string().uuid()).nonempty(),
})

export const generateQuestionsSchema = z.object({
    questionCounts: z.object({
        singleChoice: z.number().int().nonnegative().optional(),
        multipleChoice: z.number().int().nonnegative().optional(),
        trueFalse: z.number().int().nonnegative().optional(),
        fillInBlank: z.number().int().nonnegative().optional(),
        essay: z.number().int().nonnegative().optional(),
    }),
    difficulty: z.union([
        z.nativeEnum(DifficultyLevel),
        z.literal('mixed'),
    ]).default('mixed'),
    choiceOptionCount: z.union([z.literal(4), z.literal(5), z.literal(6)]).default(4),
    lessonIds: z.array(z.string().uuid()).optional(),
    topics: z.array(z.string()).optional(),
    focusAreas: z.array(z.string()).optional(),
})

export const inviteUsersSchema = z.object({
    userIds: z.array(z.string().uuid()).nonempty('At least one user is required'),
    // Backward compatible: `sendEmail` accepted from older clients.
    sendEmail: z.boolean().optional(),
    sendNotification: z.boolean().optional(),
})

export const publishExamSchema = z.object({
    userIds: z.array(z.string().uuid()).default([]),
    // Backward compatible: `sendEmail` accepted from older clients.
    sendEmail: z.boolean().optional(),
    sendNotification: z.boolean().optional(),
})

export const submitExamAnswerSchema = z.object({
    attemptId: z.string().uuid(),
    questionId: z.string().uuid(),
    answer: z.string().optional(),
    selectedOption: z.number().int().nonnegative().optional(),
})
