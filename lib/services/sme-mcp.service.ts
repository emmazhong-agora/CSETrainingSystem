import prisma from '@/lib/prisma'
import { S3_ASSET_BASE_PREFIX } from '@/lib/aws-s3'
import { TrainingOpsService } from '@/lib/services/training-ops.service'
import { CourseService } from '@/lib/services/course.service'
import { CourseStructureService } from '@/lib/services/course-structure.service'
import { ExamService } from '@/lib/services/exam.service'
import { ExamGenerationService } from '@/lib/services/exam-generation.service'
import { FileService } from '@/lib/services/file.service'
import { KnowledgeContextJobService } from '@/lib/services/knowledge-context-job.service'
import { TranscriptJobService } from '@/lib/services/transcript-job.service'
import { ExternalRecordingImportService } from '@/lib/services/external-recording-import.service'
import { WecomWebhookService } from '@/lib/services/wecom-webhook.service'
import { TrainingOpsRewardService } from '@/lib/services/training-ops-reward.service'
import { AuthUser } from '@/lib/auth-middleware'
import { DEFAULT_EXAM_TIMEZONE } from '@/lib/exam-timezone'
import { DomainGovernanceService, DomainAssignment } from '@/lib/services/domain-governance.service'
import {
    AIPromptUseCase,
    AssessmentKind,
    CourseLevel,
    CourseStatus,
    DifficultyLevel,
    ExamQuestionType,
    ExamStatus,
    LessonAssetType,
    LearningEventFormat,
    LearningEventStatus,
    LearningSeriesType,
} from '@prisma/client'
import {
    inviteUsersSchema,
} from '@/lib/validations'
import {
    getPrimaryAiTranscriptTrack,
    getTranscriptLabel,
    inferTranscriptLanguageFromFilename,
    normalizeTranscriptLanguage,
} from '@/lib/transcript-tracks'
import {
    buildEssayGradingCriteria,
    buildEssayRubricFromCriteria,
    buildEssaySampleAnswerGuidance,
    parseEssayGradingCriteria,
    sumEssayGradingCriteriaPoints,
    type EssayScoringStyle,
} from '@/lib/essay-grading'
import { v4 as uuidv4 } from 'uuid'

type MappableUser = Pick<AuthUser, 'id' | 'role'>

type ToolResult<T> = {
    success: true
    tool: string
    summary: string
    data: T
    nextActions: string[]
    recommendedNextInputs?: Record<string, unknown>
    warnings?: string[]
}

const AI_ASSISTANT_COURSE_USE_CASE = AIPromptUseCase.AI_ASSISTANT_KNOWLEDGE_CONTEXT_SYSTEM
const KNOWLEDGE_CONTEXT_OVERRIDE_USE_CASE = AIPromptUseCase.VTT_TO_XML_ENRICHMENT

const errorWithDetails = (message: string, details: unknown) =>
    Object.assign(new Error(message), { details })

const normalizeLookupValue = (value: string) => value.trim().toLowerCase()

const slugifyValue = (value: string) =>
    value
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-')

const optionalText = (value?: string | null) => {
    const normalized = value?.trim()
    return normalized ? normalized : null
}

const getErrorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)

const isUuid = (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)

const normalizeChoiceText = (value: string) =>
    value
        .trim()
        .replace(/^[A-Z]\s*[\.)、:：-]\s*/i, '')
        .replace(/^option\s+[A-Z]\s*[\.)、:：-]?\s*/i, '')
        .replace(/\s+/g, ' ')
        .toLowerCase()

const parseManualChoiceIndex = (value: unknown, options: string[]): number | null => {
    if (typeof value === 'number' && Number.isFinite(value)) {
        const index = Math.floor(value)
        return index >= 0 && index < options.length ? index : null
    }

    const raw = String(value ?? '').trim()
    if (!raw) return null

    const optionLetter = raw.match(/^(?:option\s*)?([A-Z])(?:\s*[\.)、:：-])?$/i)?.[1]
    if (optionLetter) {
        const index = optionLetter.toUpperCase().charCodeAt(0) - 65
        return index >= 0 && index < options.length ? index : null
    }

    const leadingLetter = raw.match(/^(?:option\s*)?([A-Z])\s*[\.)、:：-]\s+.+$/i)?.[1]
    if (leadingLetter) {
        const index = leadingLetter.toUpperCase().charCodeAt(0) - 65
        if (index >= 0 && index < options.length) return index
    }

    if (/^\d+$/.test(raw)) {
        const index = Number.parseInt(raw, 10)
        return index >= 0 && index < options.length ? index : null
    }

    const normalizedRaw = normalizeChoiceText(raw)
    const matchIndex = options.findIndex((option) => normalizeChoiceText(option) === normalizedRaw)
    return matchIndex >= 0 ? matchIndex : null
}

const normalizeManualCorrectAnswer = (
    type: ExamQuestionType,
    rawCorrectAnswer: unknown,
    options?: string[]
) => {
    if (rawCorrectAnswer === undefined || rawCorrectAnswer === null) return undefined

    if (type === ExamQuestionType.TRUE_FALSE) {
        const raw = String(rawCorrectAnswer).trim().toLowerCase()
        if (['true', 't', 'yes', 'y', '1'].includes(raw)) return 'true'
        if (['false', 'f', 'no', 'n', '0'].includes(raw)) return 'false'
        return String(rawCorrectAnswer).trim()
    }

    if (
        type !== ExamQuestionType.SINGLE_CHOICE &&
        type !== ExamQuestionType.MULTIPLE_CHOICE
    ) {
        return String(rawCorrectAnswer).trim()
    }

    const normalizedOptions = (options ?? []).map((option) => option.trim()).filter(Boolean)
    if (normalizedOptions.length === 0) return String(rawCorrectAnswer).trim()

    const rawParts = Array.isArray(rawCorrectAnswer)
        ? rawCorrectAnswer
        : [rawCorrectAnswer]

    if (type === ExamQuestionType.SINGLE_CHOICE) {
        const exactIndex = parseManualChoiceIndex(rawParts[0], normalizedOptions)
        return exactIndex === null ? String(rawParts[0] ?? '').trim() : String(exactIndex)
    }

    const rawText = rawParts.map((part) => String(part ?? '').trim()).filter(Boolean).join(',')
    const exactSingleIndex = parseManualChoiceIndex(rawText, normalizedOptions)
    if (exactSingleIndex !== null) return String(exactSingleIndex)

    const splitParts = rawParts.flatMap((part) =>
        String(part ?? '')
            .split(/[,;，；、\n]+/)
            .map((item) => item.trim())
            .filter(Boolean)
    )
    const indexes = Array.from(new Set(
        splitParts
            .map((part) => parseManualChoiceIndex(part, normalizedOptions))
            .filter((index): index is number => index !== null)
    ))

    return indexes.length > 0 ? indexes.join(',') : rawText
}

const buildEssayQuestionSupport = (input: {
    question: string
    points: number
    rubric?: string | null
    sampleAnswer?: string | null
    gradingCriteria?: Array<{
        id?: string
        title: string
        description?: string | null
        maxPoints: number
        guidance?: string | null
        required?: boolean
    }> | null
    essayScoringStyle?: EssayScoringStyle
    generateEssayScoringCriteria?: boolean
}) => {
    const existingCriteria = parseEssayGradingCriteria(input.gradingCriteria)
    const criteria =
        existingCriteria.length > 0
            ? existingCriteria
            : input.generateEssayScoringCriteria === false
                ? []
                : buildEssayGradingCriteria({
                    maxPoints: input.points,
                    style: input.essayScoringStyle,
                    question: input.question,
                    rubric: input.rubric,
                })

    const rubric =
        optionalText(input.rubric) ??
        (criteria.length > 0 ? buildEssayRubricFromCriteria(criteria) : null)
    const sampleAnswer =
        optionalText(input.sampleAnswer) ??
        (criteria.length > 0
            ? buildEssaySampleAnswerGuidance({
                question: input.question,
                rubric,
                criteria,
            })
            : null)

    return {
        rubric,
        sampleAnswer,
        gradingCriteria: criteria.length > 0 ? criteria : null,
        criteriaPointsTotal: sumEssayGradingCriteriaPoints(criteria),
    }
}

type DomainReference = Awaited<ReturnType<typeof TrainingOpsService.getScopedDomains>>[number]
type SeriesReference = Awaited<ReturnType<typeof TrainingOpsService.getScopedSeries>>[number]
type EventReference = Awaited<ReturnType<typeof TrainingOpsService.getScopedEvents>>[number]
type CourseReference = Awaited<ReturnType<typeof TrainingOpsService.getScopedCourses>>[number]
type ExamReference = Awaited<ReturnType<typeof TrainingOpsService.getScopedExams>>[number]

const pickReferenceMatch = <T extends { id: string }>(
    ref: string,
    candidates: T[],
    codes: {
        notFound: string
        ambiguous: string
    },
    summarize: (candidate: T) => Record<string, unknown>
) => {
    if (candidates.length === 1) {
        return candidates[0]
    }

    if (candidates.length === 0) {
        throw errorWithDetails(codes.notFound, {
            ref,
        })
    }

    throw errorWithDetails(codes.ambiguous, {
        ref,
        candidates: candidates.slice(0, 10).map(summarize),
    })
}

export class SmeMcpService {
    static async listMyWorkspace(
        user: MappableUser,
        input: {
            domainId?: string
        } = {}
    ): Promise<ToolResult<{
        scope: { domainId: string | null; domainName: string | null }
        domains: Awaited<ReturnType<typeof TrainingOpsService.getScopedSummary>>['domains']
        series: Awaited<ReturnType<typeof TrainingOpsService.getScopedSummary>>['series']
        pendingEvents: Awaited<ReturnType<typeof TrainingOpsService.getScopedSummary>>['events']
        draftCourses: Awaited<ReturnType<typeof TrainingOpsService.getScopedCourses>>
        draftExams: Awaited<ReturnType<typeof TrainingOpsService.getScopedExams>>
        atRiskDomains: Awaited<ReturnType<typeof TrainingOpsService.getScopedSummary>>['effectiveness']
        weakTopics: Awaited<ReturnType<typeof TrainingOpsService.getScopedLearnerGaps>>['weakTopics']
        learnerGaps: Awaited<ReturnType<typeof TrainingOpsService.getScopedLearnerGaps>>['learnerGaps']
    }>> {
        const [summary, courses, exams] = await Promise.all([
            TrainingOpsService.getScopedSummary(user),
            TrainingOpsService.getScopedCourses(user),
            TrainingOpsService.getScopedExams(user),
        ])

        const domainId = input.domainId
        const selectedDomain = domainId
            ? summary.domains.find((domain) => domain.id === domainId)
            : null

        if (domainId && !selectedDomain) {
            throw errorWithDetails('DOMAIN_REFERENCE_NOT_FOUND', { ref: domainId })
        }

        const learnerGaps = await TrainingOpsService.getScopedLearnerGaps(
            user,
            domainId ? { domainIds: [domainId] } : {}
        )

        const domains = domainId
            ? summary.domains.filter((domain) => domain.id === domainId)
            : summary.domains

        const domainIds = new Set(domains.map((domain) => domain.id))
        const series = domainId
            ? summary.series.filter((item) => item.domain?.id ? domainIds.has(item.domain.id) : false)
            : summary.series

        const seriesIds = new Set(series.map((item) => item.id))
        const pendingEvents = summary.events
            .filter((event) => {
                const matchesDomain = !domainId || (event.domain?.id ? domainIds.has(event.domain.id) : false)
                const matchesSeries = !domainId || (event.series?.id ? seriesIds.has(event.series.id) : false)
                const matchesScope = !domainId || matchesDomain || matchesSeries
                return matchesScope && event.status === 'IN_PROGRESS'
            })
            .slice(0, 10)

        const draftCourses = courses
            .filter((course) => course.status === 'DRAFT' && (!domainId || course.productDomainId === domainId))
            .slice(0, 10)

        const draftExams = exams
            .filter((exam) => exam.status === 'DRAFT' && (!domainId || exam.productDomainId === domainId))
            .slice(0, 10)

        const atRiskDomains = summary.effectiveness
            .filter((row) => (!domainId || row.id === domainId) && row.status !== 'ON_TRACK')
            .slice(0, 10)

        return {
            success: true,
            tool: 'list_my_workspace',
            summary: `Returned ${domains.length} domains, ${series.length} Learning Programs, and ${pendingEvents.length} pending events.`,
            data: {
                scope: {
                    domainId: selectedDomain?.id ?? null,
                    domainName: selectedDomain?.name ?? null,
                },
                domains,
                series,
                pendingEvents,
                draftCourses,
                draftExams,
                atRiskDomains,
                weakTopics: learnerGaps.weakTopics,
                learnerGaps: learnerGaps.learnerGaps,
            },
            nextActions: ['get_training_ops_action_center', 'get_domain_health', 'create_learning_program', 'create_event'],
        }
    }

    private static async resolveDomainReference(user: MappableUser, ref: string): Promise<DomainReference> {
        const domains = await TrainingOpsService.getScopedDomains(user)
        const trimmed = ref.trim()
        const normalized = normalizeLookupValue(trimmed)
        const slugCandidate = slugifyValue(trimmed)

        const directIdMatch = domains.find((domain) => domain.id === trimmed)
        if (directIdMatch) {
            return directIdMatch
        }

        const matches = domains.filter((domain) => {
            const slug = normalizeLookupValue(domain.slug)
            const name = normalizeLookupValue(domain.name)
            return slug === normalized || name === normalized || slug === slugCandidate
        })

        return pickReferenceMatch(
            ref,
            matches,
            {
                notFound: 'DOMAIN_REFERENCE_NOT_FOUND',
                ambiguous: 'DOMAIN_REFERENCE_AMBIGUOUS',
            },
            (domain) => ({ id: domain.id, slug: domain.slug, name: domain.name })
        )
    }

    private static async resolveSeriesReference(
        user: MappableUser,
        ref: string,
        options?: { domainId?: string | null }
    ): Promise<SeriesReference> {
        const scopedSeries = await TrainingOpsService.getScopedSeries(user)
        const series = options?.domainId
            ? scopedSeries.filter((item) => item.domain?.id === options.domainId)
            : scopedSeries

        const trimmed = ref.trim()
        const normalized = normalizeLookupValue(trimmed)
        const slugCandidate = slugifyValue(trimmed)

        const directIdMatch = series.find((item) => item.id === trimmed)
        if (directIdMatch) {
            return directIdMatch
        }

        const matches = series.filter((item) => {
            const slug = normalizeLookupValue(item.slug)
            const name = normalizeLookupValue(item.name)
            return slug === normalized || name === normalized || slug === slugCandidate
        })

        return pickReferenceMatch(
            ref,
            matches,
            {
                notFound: 'SERIES_REFERENCE_NOT_FOUND',
                ambiguous: 'SERIES_REFERENCE_AMBIGUOUS',
            },
            (item) => ({
                id: item.id,
                slug: item.slug,
                name: item.name,
                domainId: item.domain?.id ?? null,
            })
        )
    }

    private static async resolveEventReference(user: MappableUser, ref: string): Promise<EventReference> {
        const events = await TrainingOpsService.getScopedEvents(user)
        const trimmed = ref.trim()
        const normalized = normalizeLookupValue(trimmed)

        const directIdMatch = events.find((event) => event.id === trimmed)
        if (directIdMatch) {
            return directIdMatch
        }

        const matches = events.filter((event) => normalizeLookupValue(event.title) === normalized)

        return pickReferenceMatch(
            ref,
            matches,
            {
                notFound: 'EVENT_REFERENCE_NOT_FOUND',
                ambiguous: 'EVENT_REFERENCE_AMBIGUOUS',
            },
            (event) => ({
                id: event.id,
                title: event.title,
                seriesId: event.series?.id ?? null,
                domainId: event.domain?.id ?? null,
            })
        )
    }

    private static async resolveCourseReference(user: MappableUser, ref: string): Promise<CourseReference> {
        const courses = await TrainingOpsService.getScopedCourses(user)
        const trimmed = ref.trim()
        const normalized = normalizeLookupValue(trimmed)
        const slugCandidate = slugifyValue(trimmed)

        const directIdMatch = courses.find((course) => course.id === trimmed)
        if (directIdMatch) {
            return directIdMatch
        }

        const matches = courses.filter((course) => {
            const title = normalizeLookupValue(course.title)
            const slug = normalizeLookupValue(course.slug)
            return title === normalized || slug === normalized || slug === slugCandidate
        })

        return pickReferenceMatch(
            ref,
            matches,
            {
                notFound: 'COURSE_REFERENCE_NOT_FOUND',
                ambiguous: 'COURSE_REFERENCE_AMBIGUOUS',
            },
            (course) => ({
                id: course.id,
                title: course.title,
                slug: course.slug,
                learningEventId: course.learningEventId ?? null,
            })
        )
    }

    private static async resolveExamReference(user: MappableUser, ref: string): Promise<ExamReference> {
        const exams = await TrainingOpsService.getScopedExams(user)
        const trimmed = ref.trim()
        const normalized = normalizeLookupValue(trimmed)

        const directIdMatch = exams.find((exam) => exam.id === trimmed)
        if (directIdMatch) {
            return directIdMatch
        }

        const matches = exams.filter((exam) => normalizeLookupValue(exam.title) === normalized)

        return pickReferenceMatch(
            ref,
            matches,
            {
                notFound: 'EXAM_REFERENCE_NOT_FOUND',
                ambiguous: 'EXAM_REFERENCE_AMBIGUOUS',
            },
            (exam) => ({
                id: exam.id,
                title: exam.title,
                learningEventId: exam.learningEventId ?? null,
            })
        )
    }

    private static async resolveActiveUserReference(user: MappableUser, ref?: string | null) {
        if (!ref || ref.trim().length === 0 || ref === 'current_user') {
            const currentUser = await prisma.user.findUnique({
                where: { id: user.id },
                select: { id: true, name: true, email: true, status: true },
            })

            if (!currentUser || currentUser.status !== 'ACTIVE') {
                throw new Error('USER_REFERENCE_NOT_FOUND')
            }

            return currentUser
        }

        const trimmed = ref.trim()
        const resolvedUser = await prisma.user.findFirst({
            where: isUuid(trimmed)
                ? { id: trimmed, status: 'ACTIVE' }
                : { email: { equals: trimmed, mode: 'insensitive' }, status: 'ACTIVE' },
            select: {
                id: true,
                name: true,
                email: true,
                status: true,
            },
        })

        if (!resolvedUser) {
            throw errorWithDetails('USER_REFERENCE_NOT_FOUND', {
                ref,
            })
        }

        return resolvedUser
    }

    private static async getActiveDefaultCourseTemplate() {
        const defaultTemplate = await prisma.aIPromptDefault.findUnique({
            where: { useCase: AI_ASSISTANT_COURSE_USE_CASE },
            include: {
                template: {
                    select: {
                        id: true,
                        name: true,
                        useCase: true,
                        isActive: true,
                    },
                },
            },
        })

        if (!defaultTemplate?.template?.isActive) {
            return null
        }

        return {
            id: defaultTemplate.template.id,
            name: defaultTemplate.template.name,
            useCase: defaultTemplate.template.useCase,
        }
    }

    static async createBadge(
        user: MappableUser,
        input: {
            name: string
            domain: string
            thresholdStars: number
            icon?: string | null
            description?: string | null
            active?: boolean
        }
    ): Promise<ToolResult<{
        badge: Awaited<ReturnType<typeof TrainingOpsService.createScopedBadgeMilestone>>
        normalized: {
            slug: string
            domainId: string
        }
    }>> {
        const domain = await this.resolveDomainReference(user, input.domain)
        const badge = await TrainingOpsService.createScopedBadgeMilestone(user, {
            name: input.name.trim(),
            slug: slugifyValue(input.name),
            description: optionalText(input.description),
            icon: optionalText(input.icon),
            thresholdStars: input.thresholdStars,
            active: input.active ?? true,
            domainId: domain.id,
        })

        return {
            success: true,
            tool: 'create_badge',
            summary: `Created badge "${badge.name}" in domain "${domain.name}".`,
            data: {
                badge,
                normalized: {
                    slug: badge.slug,
                    domainId: domain.id,
                },
            },
            nextActions: ['list_my_workspace', 'create_learning_program'],
            recommendedNextInputs: {
                list_my_workspace: {
                    domainId: domain.id,
                },
            },
        }
    }

    static async createSeries(
        user: MappableUser,
        input: {
            name: string
            seriesType: LearningSeriesType
            productDomain: string
            seriesOwner?: string | null
            cadence?: string | null
            description?: string | null
            active?: boolean
            contributesToDomainBadges?: boolean
        },
        toolName: 'create_series' | 'create_learning_program' = 'create_series'
    ): Promise<ToolResult<{
        program: Awaited<ReturnType<typeof TrainingOpsService.createScopedLearningSeries>>
        series: Awaited<ReturnType<typeof TrainingOpsService.createScopedLearningSeries>>
        normalized: {
            slug: string
            domainId: string
            ownerId: string | null
        }
    }>> {
        const domain = await this.resolveDomainReference(user, input.productDomain)
        const owner =
            user.role === 'ADMIN'
                ? await this.resolveActiveUserReference(user, input.seriesOwner ?? 'current_user')
                : await this.resolveActiveUserReference(user, 'current_user')

        const series = await TrainingOpsService.createScopedLearningSeries(user, {
            name: input.name.trim(),
            slug: slugifyValue(input.name),
            type: input.seriesType,
            domainId: domain.id,
            description: optionalText(input.description),
            cadence: optionalText(input.cadence),
            isActive: input.active ?? true,
            badgeEligible: input.contributesToDomainBadges ?? true,
            countsTowardPerformance: false,
            defaultStarValue: null,
            ownerId: owner.id,
        })

        return {
            success: true,
            tool: toolName,
            summary: `Created learning program "${series.name}" in domain "${domain.name}".`,
            data: {
                program: series,
                series,
                normalized: {
                    slug: series.slug,
                    domainId: domain.id,
                    ownerId: series.owner?.id ?? owner.id,
                },
            },
            nextActions: ['create_event', 'list_my_workspace'],
            recommendedNextInputs: {
                create_event: {
                    learningProgram: series.id,
                    productDomain: domain.id,
                },
            },
            ...(toolName === 'create_series'
                ? { warnings: ['create_series is retained for compatibility; prefer create_learning_program.'] }
                : {}),
        }
    }

    static async getTrainingOpsActionCenter(
        user: MappableUser,
        input: { domainId?: string } = {}
    ): Promise<ToolResult<Record<string, unknown>>> {
        const workspace = await this.listMyWorkspace(user, input)
        const data = workspace.data
        const eventScheduleGaps = data.pendingEvents.filter((event) => !event.scheduledAt)
        const learnerGaps = data.learnerGaps.filter((learner) => learner.passRate < 70)
        const domainGovernance = user.role === 'ADMIN'
            ? await DomainGovernanceService.audit(user)
            : null
        const domainAssociationGaps = domainGovernance?.records.filter((record) =>
            record.resolution.status !== 'SCOPED'
        ) ?? []

        const recommendedActions = [
            ...(eventScheduleGaps.length > 0
                ? [`Schedule ${eventScheduleGaps.length} event${eventScheduleGaps.length === 1 ? '' : 's'} that currently have no date.`]
                : []),
            ...(learnerGaps.length > 0
                ? [`Review ${learnerGaps.length} learner${learnerGaps.length === 1 ? '' : 's'} below the 70% pass-rate threshold.`]
                : []),
            ...(data.atRiskDomains.length > 0
                ? [`Create an intervention plan for ${data.atRiskDomains.length} domain${data.atRiskDomains.length === 1 ? '' : 's'} not currently on track.`]
                : []),
            ...(data.weakTopics.length > 0
                ? [`Prioritize refresher content for ${data.weakTopics.slice(0, 3).map((topic) => topic.topic).filter(Boolean).join(', ')}.`]
                : []),
            ...(domainAssociationGaps.length > 0
                ? [`Review ${domainAssociationGaps.length} missing, suggested, or conflicting Domain association${domainAssociationGaps.length === 1 ? '' : 's'}.`]
                : []),
        ]

        return {
            success: true,
            tool: 'get_training_ops_action_center',
            summary: `Found ${eventScheduleGaps.length} scheduling gaps, ${learnerGaps.length} learner gaps, and ${data.atRiskDomains.length} domains needing attention.`,
            data: {
                scope: data.scope,
                eventScheduleGaps,
                learnerGaps,
                weakTopics: data.weakTopics.map((topic) => ({
                    ...topic,
                    missRate: topic.answered > 0 ? Math.round((topic.misses / topic.answered) * 100) : 0,
                })),
                domainsNeedingAttention: data.atRiskDomains,
                domainAssociationGaps,
                recommendedActions,
            },
            nextActions: domainAssociationGaps.length > 0
                ? ['audit_domain_associations', 'get_domain_health', 'create_event', 'create_course', 'create_exam']
                : ['get_domain_health', 'create_event', 'create_course', 'create_exam'],
        }
    }

    static async getDomainHealth(
        user: MappableUser,
        input: { domainId?: string } = {}
    ): Promise<ToolResult<Record<string, unknown>>> {
        const summary = await TrainingOpsService.getScopedSummary(user)
        const selectedDomain = input.domainId
            ? summary.domains.find((domain) => domain.id === input.domainId)
            : null

        if (input.domainId && !selectedDomain) {
            throw errorWithDetails('DOMAIN_REFERENCE_NOT_FOUND', { ref: input.domainId })
        }

        const health = summary.effectiveness.filter((domain) => !input.domainId || domain.id === input.domainId)
        const measuredDomains = health.filter((domain) => domain.gradedAttempts > 0)
        const noDataDomains = health.filter((domain) => domain.gradedAttempts === 0)

        return {
            success: true,
            tool: 'get_domain_health',
            summary: `Returned health for ${health.length} domain${health.length === 1 ? '' : 's'}; ${noDataDomains.length} currently lack graded-attempt data.`,
            data: {
                scope: {
                    domainId: selectedDomain?.id ?? null,
                    domainName: selectedDomain?.name ?? null,
                },
                measuredDomains: measuredDomains.map((domain) => ({
                    ...domain,
                    confidence: domain.gradedAttempts >= 20 ? 'HIGH' : domain.gradedAttempts >= 5 ? 'MEDIUM' : 'LOW',
                })),
                noDataDomains,
            },
            nextActions: ['get_training_ops_action_center', 'list_my_workspace'],
        }
    }

    static async auditDomainAssociations(user: MappableUser): Promise<ToolResult<Record<string, unknown>>> {
        const audit = await DomainGovernanceService.audit(user)
        return {
            success: true,
            tool: 'audit_domain_associations',
            summary: `Audited ${audit.records.length} Programs, Events, Courses, and Exams for Domain coverage.`,
            data: audit,
            nextActions: ['propose_domain_assignments'],
        }
    }

    static async proposeDomainAssignments(user: MappableUser): Promise<ToolResult<Record<string, unknown>>> {
        const proposal = await DomainGovernanceService.proposeAssignments(user)
        return {
            success: true,
            tool: 'propose_domain_assignments',
            summary: `Proposed ${proposal.summary.total} Program/Event assignments and ${proposal.summary.associationSuggestions} Course/Exam Event-association suggestions.`,
            data: proposal,
            nextActions: proposal.summary.total > 0 ? ['apply_domain_assignments'] : ['audit_domain_associations'],
            warnings: ['Course and Exam suggestions are never written as direct Domain assignments; attach them to a reviewed Event.'],
        }
    }

    static async applyDomainAssignments(
        user: MappableUser,
        input: {
            assignments: DomainAssignment[]
            dryRun?: boolean
            confirm?: boolean
            confirmationToken?: string
            idempotencyKey?: string
        }
    ): Promise<ToolResult<Record<string, unknown>>> {
        if (input.dryRun !== false || input.confirm !== true) {
            const preview = await DomainGovernanceService.previewAssignments(user, input.assignments)
            return {
                success: true,
                tool: 'apply_domain_assignments',
                summary: `Dry run prepared ${preview.changes.length} version-checked Domain assignments.`,
                data: { dryRun: true, ...preview, idempotencyKey: input.idempotencyKey ?? null },
                nextActions: ['apply_domain_assignments'],
                warnings: ['No data was changed. Re-submit the exact assignments with dryRun=false, confirm=true, and this confirmationToken.'],
            }
        }

        if (!input.confirmationToken) throw new Error('DOMAIN_ASSIGNMENT_CONFIRMATION_REQUIRED')
        const result = await DomainGovernanceService.applyAssignments(user, input.assignments, input.confirmationToken)
        return {
            success: true,
            tool: 'apply_domain_assignments',
            summary: `Applied ${result.updated} Domain assignments; ${result.unchanged} were already current.`,
            data: { dryRun: false, ...result, idempotencyKey: input.idempotencyKey ?? null },
            nextActions: ['audit_domain_associations'],
        }
    }

    static async manageDomainAlias(
        user: MappableUser,
        input: {
            domainId: string
            alias: string
            dryRun?: boolean
            confirm?: boolean
            confirmationToken?: string
        }
    ): Promise<ToolResult<Record<string, unknown>>> {
        if (input.dryRun !== false || input.confirm !== true) {
            const preview = await DomainGovernanceService.previewAlias(user, input)
            return {
                success: true,
                tool: 'manage_domain_alias',
                summary: preview.noOp ? 'The normalized alias already maps to this Domain.' : 'Domain alias preview is ready.',
                data: { dryRun: true, ...preview },
                nextActions: preview.noOp ? ['propose_domain_assignments'] : ['manage_domain_alias'],
                warnings: preview.noOp ? undefined : ['No data was changed. Confirm with the returned token to create this exact alias.'],
            }
        }

        if (!input.confirmationToken) throw new Error('DOMAIN_ALIAS_CONFIRMATION_REQUIRED')
        const result = await DomainGovernanceService.applyAlias(user, input, input.confirmationToken)
        return {
            success: true,
            tool: 'manage_domain_alias',
            summary: result.created ? 'Created the managed Domain alias.' : 'The Domain alias was already current.',
            data: { dryRun: false, ...result },
            nextActions: ['propose_domain_assignments'],
        }
    }

    static async createEvent(
        user: MappableUser,
        input: {
            title: string
            learningProgram?: string
            learningSeries?: string
            format: LearningEventFormat
            status?: LearningEventStatus
            host?: string | null
            productDomain?: string | null
            description?: string | null
            scheduledAt?: Date | null
            countsTowardPerformance?: boolean
        }
    ): Promise<ToolResult<{
        event: Awaited<ReturnType<typeof TrainingOpsService.createScopedLearningEvent>>
        resolvedProgram: {
            id: string
            name: string
            slug: string
            type: LearningSeriesType
        } | null
        resolvedSeries: {
            id: string
            name: string
            slug: string
            type: LearningSeriesType
        } | null
        resolvedDomain: {
            id: string | null
            name: string | null
            slug: string | null
        }
    }>> {
        const programRef = input.learningProgram ?? input.learningSeries
        const series = programRef
            ? await this.resolveSeriesReference(user, programRef)
            : null
        const explicitDomain = input.productDomain
            ? await this.resolveDomainReference(user, input.productDomain)
            : null
        const host = input.host
            ? await this.resolveActiveUserReference(user, input.host)
            : await this.resolveActiveUserReference(user, 'current_user')

        const event = await TrainingOpsService.createScopedLearningEvent(user, {
            title: input.title.trim(),
            format: input.format,
            status: input.status ?? LearningEventStatus.IN_PROGRESS,
            domainId: explicitDomain?.id ?? series?.domain?.id ?? null,
            seriesId: series?.id ?? null,
            description: optionalText(input.description),
            scheduledAt: input.scheduledAt ?? null,
            isRequired: false,
            countsTowardPerformance: input.countsTowardPerformance ?? false,
            hostId: host.id,
        })

        return {
            success: true,
            tool: 'create_event',
            summary: series
                ? `Created event "${event.title}" in learning program "${series.name}".`
                : `Created standalone event "${event.title}" in domain "${explicitDomain?.name}".`,
            data: {
                event,
                resolvedProgram: series ? {
                    id: series.id,
                    name: series.name,
                    slug: series.slug,
                    type: series.type,
                } : null,
                resolvedSeries: series ? {
                    id: series.id,
                    name: series.name,
                    slug: series.slug,
                    type: series.type,
                } : null,
                resolvedDomain: {
                    id: event.domain?.id ?? series?.domain?.id ?? null,
                    name: event.domain?.name ?? series?.domain?.name ?? null,
                    slug: event.domain?.slug ?? series?.domain?.slug ?? null,
                },
            },
            nextActions: ['create_course', 'create_exam', 'review_event_status'],
            recommendedNextInputs: {
                create_course: {
                    event: event.id,
                },
                create_exam: {
                    event: event.id,
                },
                review_event_status: {
                    event: event.id,
                },
            },
            ...(input.learningSeries && !input.learningProgram
                ? { warnings: ['learningSeries is retained for compatibility; prefer learningProgram.'] }
                : {}),
        }
    }

    static async createCourse(
        user: MappableUser,
        input: {
            title: string
            event?: string | null
            description?: string | null
            whatYouWillLearn?: string[]
            requirements?: string[]
            thumbnailUrl?: string | null
            category?: string | null
            level?: CourseLevel
            status?: CourseStatus
            instructor?: string | null
            tags?: string[]
        }
    ): Promise<ToolResult<{
        course: Awaited<ReturnType<typeof CourseService.createCourse>>
        binding: {
            mode: 'standalone' | 'event-bound'
            event: {
                id: string
                title: string
            } | null
        }
        aiAssistant: {
            enabled: boolean
            mode: 'default'
            template: {
                id: string
                name: string
            } | null
        }
    }>> {
        const resolvedEvent = input.event ? await this.resolveEventReference(user, input.event) : null
        const instructor =
            user.role === 'ADMIN'
                ? await this.resolveActiveUserReference(user, input.instructor ?? 'current_user')
                : await this.resolveActiveUserReference(user, 'current_user')

        if (resolvedEvent) {
            await TrainingOpsService.getScopedLearningEventById(user, resolvedEvent.id)
        }

        const course = await CourseService.createCourse({
            title: input.title.trim(),
            slug: slugifyValue(input.title),
            description: optionalText(input.description) ?? `${input.title.trim()} course`,
            thumbnail: optionalText(input.thumbnailUrl) ?? undefined,
            level: input.level ?? CourseLevel.BEGINNER,
            category: optionalText(input.category) ?? resolvedEvent?.domain?.name ?? 'General',
            tags: input.tags ?? [],
            learningOutcomes: input.whatYouWillLearn ?? [],
            requirements: input.requirements ?? [],
            instructorId: instructor.id,
            learningEventId: resolvedEvent?.id ?? null,
            status: input.status ?? CourseStatus.DRAFT,
        })

        const defaultTemplate = await this.getActiveDefaultCourseTemplate()
        const warnings: string[] = []
        if (!defaultTemplate) {
            warnings.push('No active admin default AI template is configured for courses. The course still uses default assistant behavior.')
        }

        return {
            success: true,
            tool: 'create_course',
            summary: resolvedEvent
                ? `Created course "${course.title}" and linked it to event "${resolvedEvent.title}".`
                : `Created standalone course "${course.title}".`,
            data: {
                course,
                binding: {
                    mode: resolvedEvent ? 'event-bound' : 'standalone',
                    event: resolvedEvent
                        ? {
                            id: resolvedEvent.id,
                            title: resolvedEvent.title,
                        }
                        : null,
                },
                aiAssistant: {
                    enabled: true,
                    mode: 'default',
                    template: defaultTemplate
                        ? {
                            id: defaultTemplate.id,
                            name: defaultTemplate.name,
                        }
                        : null,
                },
            },
            nextActions: resolvedEvent ? ['review_event_status'] : ['list_my_workspace'],
            recommendedNextInputs: resolvedEvent
                ? {
                    review_event_status: {
                        event: resolvedEvent.id,
                    },
                }
                : undefined,
            ...(warnings.length > 0 ? { warnings } : {}),
        }
    }

    static async createExam(
        user: MappableUser,
        input: {
            title: string
            event?: string | null
            description?: string | null
            instructions?: string | null
            examType?: AssessmentKind
            awardsStars?: boolean
            starValue?: number
            countsTowardPerformance?: boolean
            totalScore: number
            passingScore: number
            maxAttempts: number
            options?: {
                timeLimit?: number
                randomizeQuestions?: boolean
                randomizeOptions?: boolean
                showResultsImmediately?: boolean
                allowReview?: boolean
            } | null
        }
    ): Promise<ToolResult<{
        exam: Awaited<ReturnType<typeof ExamService.createExam>>
        binding: {
            mode: 'standalone' | 'event-bound'
            event: {
                id: string
                title: string
            } | null
        }
        resolvedOptions: {
            timeLimit: number | null
            randomizeQuestions: boolean
            randomizeOptions: boolean
            showResultsImmediately: boolean
            allowReview: boolean
            timezone: string
            assessmentKind: AssessmentKind
            awardsStars: boolean
            starValue: number
            countsTowardPerformance: boolean
        }
    }>> {
        const resolvedEvent = input.event ? await this.resolveEventReference(user, input.event) : null
        if (resolvedEvent) {
            await TrainingOpsService.getScopedLearningEventById(user, resolvedEvent.id)
        }

        const timeLimit = input.options?.timeLimit
        const randomizeQuestions = input.options?.randomizeQuestions ?? false
        const randomizeOptions = input.options?.randomizeOptions ?? false
        const showResultsImmediately = input.options?.showResultsImmediately ?? true
        const allowReview = input.options?.allowReview ?? true
        const assessmentKind = input.examType ?? AssessmentKind.PRACTICE
        const awardsStars = input.awardsStars ?? true
        const starValue = input.starValue ?? (awardsStars ? 3 : 0)
        const countsTowardPerformance = input.countsTowardPerformance ?? false

        const exam = await ExamService.createExam(
            {
                title: input.title.trim(),
                description: optionalText(input.description) ?? undefined,
                instructions: optionalText(input.instructions) ?? undefined,
                timezone: DEFAULT_EXAM_TIMEZONE,
                totalScore: input.totalScore,
                passingScore: input.passingScore,
                maxAttempts: input.maxAttempts,
                timeLimit,
                randomizeQuestions,
                randomizeOptions,
                showResultsImmediately,
                allowReview,
                assessmentKind,
                awardsStars,
                starValue,
                countsTowardPerformance,
                learningEventId: resolvedEvent?.id ?? null,
                sourceLearningEventId: resolvedEvent?.id ?? null,
            },
            user.id,
            resolvedEvent ? undefined : { actorRole: user.role }
        )

        return {
            success: true,
            tool: 'create_exam',
            summary: resolvedEvent
                ? `Created exam "${exam.title}" and linked it to event "${resolvedEvent.title}".`
                : `Created standalone exam "${exam.title}".`,
            data: {
                exam,
                binding: {
                    mode: resolvedEvent ? 'event-bound' : 'standalone',
                    event: resolvedEvent
                        ? {
                            id: resolvedEvent.id,
                            title: resolvedEvent.title,
                        }
                        : null,
                },
                resolvedOptions: {
                    timeLimit: timeLimit ?? null,
                    randomizeQuestions,
                    randomizeOptions,
                    showResultsImmediately,
                    allowReview,
                    timezone: DEFAULT_EXAM_TIMEZONE,
                    assessmentKind,
                    awardsStars,
                    starValue,
                    countsTowardPerformance,
                },
            },
            nextActions: resolvedEvent ? ['review_event_status', 'publish_exam_for_learners'] : ['list_my_workspace'],
            recommendedNextInputs: resolvedEvent
                ? {
                    review_event_status: {
                        event: resolvedEvent.id,
                    },
                    publish_exam_for_learners: {
                        exam: exam.id,
                        userIds: [],
                        sendNotification: false,
                    },
                }
                : undefined,
        }
    }

    static async attachExamToEvent(
        user: MappableUser,
        input: {
            exam: string
            event: string
        }
    ): Promise<ToolResult<{
        event: Awaited<ReturnType<typeof TrainingOpsService.attachScopedExamToEvent>>
        exam: {
            id: string
            title: string
        }
        binding: {
            eventId: string
            examId: string
        }
    }>> {
        const event = await this.resolveEventReference(user, input.event)
        const exam = await this.resolveExamReference(user, input.exam)
        const updatedEvent = await TrainingOpsService.attachScopedExamToEvent(user, event.id, exam.id)

        return {
            success: true,
            tool: 'attach_exam_to_event',
            summary: `Attached exam "${exam.title}" to event "${event.title}".`,
            data: {
                event: updatedEvent,
                exam: {
                    id: exam.id,
                    title: exam.title,
                },
                binding: {
                    eventId: event.id,
                    examId: exam.id,
                },
            },
            nextActions: ['review_event_status', 'publish_exam_for_learners'],
            recommendedNextInputs: {
                review_event_status: {
                    event: event.id,
                },
                publish_exam_for_learners: {
                    exam: exam.id,
                    userIds: [],
                    sendNotification: false,
                },
            },
        }
    }

    private static buildGeneratedCourseOutline(input: {
        courseTitle: string
        brief: string
        lessonCount?: number
    }) {
        const totalLessons = Math.max(1, Math.min(input.lessonCount ?? 3, 12))
        const foundationTemplates = ['Context and Goals', 'Core Concepts', 'Common Scenarios']
        const appliedTemplates = ['Troubleshooting Workflow', 'Applied Practice', 'Knowledge Check']
        const chapterTemplates =
            totalLessons <= 3
                ? [
                    {
                        title: 'Foundation',
                        templates: foundationTemplates,
                    },
                ]
                : [
                    {
                        title: 'Foundation',
                        templates: foundationTemplates,
                    },
                    {
                        title: 'Applied Practice',
                        templates: appliedTemplates,
                    },
                ]

        let lessonCursor = 0
        return chapterTemplates.map((chapter, chapterIndex) => {
            const remaining = totalLessons - lessonCursor
            const chapterLessonCount =
                chapterIndex === chapterTemplates.length - 1
                    ? remaining
                    : Math.max(1, Math.ceil(totalLessons / chapterTemplates.length))

            const lessons = Array.from({ length: chapterLessonCount }).map((_, index) => {
                const template = chapter.templates[index] ?? `Lesson ${lessonCursor + 1}`
                lessonCursor += 1
                return {
                    title: `${input.courseTitle}: ${template}`,
                    objective: `Help learners understand ${template.toLowerCase()} for ${input.courseTitle}.`,
                    summary: input.brief,
                }
            })

            return {
                title: chapter.title,
                description: input.brief,
                lessons,
            }
        })
    }

    static async designCourse(
        user: MappableUser,
        input: {
            course: string
            mode: 'generate_outline' | 'manual_outline'
            brief?: string
            targetAudience?: string | null
            lessonCount?: number
            chapters?: Array<{
                title: string
                description?: string | null
                lessons: Array<{
                    title: string
                    objective?: string | null
                    summary?: string | null
                }>
            }>
            assetPlan?: Array<{
                lessonRef: string
                assetType: LessonAssetType
                title: string
                sourceKind: 'upload' | 'external_url' | 's3_object'
                sourceBucket?: string
                sourceKey?: string
                sourceRegion?: string
                sourceContentType?: string
                transcriptBucket?: string
                transcriptKey?: string
                transcriptRegion?: string
                transcriptFormat?: 'AUTO' | 'TIMESTAMPED_TEXT' | 'PLAIN_TEXT'
                transcriptLanguage?: string
                transcriptLabel?: string | null
                setTranscriptAsDefaultSubtitle?: boolean
                setTranscriptAsPrimaryForAI?: boolean
                processKnowledge?: boolean
                transcriptNeeded?: boolean
            }>
            transcriptPlan?: Array<{
                lessonRef: string
                languageCode?: string
                setAsDefaultSubtitle?: boolean
                setAsPrimaryForAI?: boolean
            }>
        }
    ): Promise<ToolResult<{
        course: {
            id: string
            title: string
            slug: string
        }
        mode: 'generate_outline' | 'manual_outline'
        chaptersCreated: Array<{
            id: string
            title: string
            description: string | null
        }>
        lessonsCreated: Array<{
            id: string
            chapterId: string
            title: string
            objective: string | null
            summary: string | null
        }>
        courseStructure: Array<{
            chapterId: string
            chapterTitle: string
            lessons: Array<{
                lessonId: string
                lessonTitle: string
            }>
        }>
        uploadTasks: Array<{
            lessonRef: string
            lessonId: string | null
            title: string
            assetType: LessonAssetType
            sourceKind: 'upload' | 'external_url' | 's3_object'
            transcriptNeeded: boolean
            status: 'ready' | 'unresolved'
        }>
        assetImports: Array<{
            lessonRef: string
            lessonId: string | null
            assetId?: string
            title: string
            assetType: LessonAssetType
            sourceKind: 's3_object'
            sourceBucket: string
            sourceKey: string
            s3Key?: string
            mimeType?: string | null
            url?: string
            status: 'imported' | 'failed'
            error?: string
        }>
        transcriptImports: Array<{
            lessonRef: string
            lessonId: string | null
            videoAssetId?: string
            transcriptAssetId?: string
            textAssetId?: string
            sourceBucket: string
            sourceKey: string
            sourceFormat?: 'TIMESTAMPED_TEXT' | 'PLAIN_TEXT'
            storedFormat?: 'VTT' | 'TEXT'
            cuesCount?: number
            knowledgeProcessing?: {
                status: 'queued' | 'skipped'
                jobId?: string
            }
            status: 'imported' | 'plain_text_imported' | 'skipped' | 'failed'
            warning?: string
            error?: string
        }>
        transcriptTasks: Array<{
            lessonRef: string
            lessonId: string | null
            languageCode: string
            setAsDefaultSubtitle: boolean
            setAsPrimaryForAI: boolean
            status: 'ready' | 'unresolved'
        }>
    }>> {
        const course = await this.resolveCourseReference(user, input.course)
        await TrainingOpsService.assertScopedCourseAccess(user, course.id)

        const outline =
            input.mode === 'manual_outline'
                ? input.chapters ?? []
                : this.buildGeneratedCourseOutline({
                    courseTitle: course.title,
                    brief: input.brief?.trim() || `${course.title} course outline`,
                    lessonCount: input.lessonCount,
                })

        const createdChapters: Array<{ id: string; title: string; description: string | null }> = []
        const createdLessons: Array<{ id: string; chapterId: string; title: string; objective: string | null; summary: string | null }> = []
        const lessonLookup = new Map<string, { id: string; title: string }>()

        for (const chapterInput of outline) {
            const createdChapter = await CourseStructureService.createChapter(course.id, {
                title: chapterInput.title.trim(),
                description: optionalText(chapterInput.description),
            })

            createdChapters.push({
                id: createdChapter.id,
                title: createdChapter.title,
                description: createdChapter.description ?? null,
            })

            for (const lessonInput of chapterInput.lessons) {
                const objective = optionalText(lessonInput.objective)
                const summary = optionalText(lessonInput.summary)
                const createdLesson = await CourseStructureService.createLesson(createdChapter.id, {
                    title: lessonInput.title.trim(),
                    description: summary ?? objective ?? undefined,
                    learningObjectives: objective ? [objective] : [],
                })

                createdLessons.push({
                    id: createdLesson.id,
                    chapterId: createdChapter.id,
                    title: createdLesson.title,
                    objective,
                    summary,
                })

                lessonLookup.set(createdLesson.id, { id: createdLesson.id, title: createdLesson.title })
                lessonLookup.set(normalizeLookupValue(createdLesson.title), { id: createdLesson.id, title: createdLesson.title })
            }
        }

        const uploadTasks = (input.assetPlan ?? []).map((task) => {
            const resolvedLesson =
                lessonLookup.get(task.lessonRef) ??
                lessonLookup.get(normalizeLookupValue(task.lessonRef))

            return {
                lessonRef: task.lessonRef,
                lessonId: resolvedLesson?.id ?? null,
                title: task.title,
                assetType: task.assetType,
                sourceKind: task.sourceKind,
                transcriptNeeded: task.transcriptNeeded ?? Boolean(task.transcriptKey?.trim()),
                status: resolvedLesson ? 'ready' as const : 'unresolved' as const,
            }
        })

        const transcriptTasks = (input.transcriptPlan ?? []).map((task) => {
            const resolvedLesson =
                lessonLookup.get(task.lessonRef) ??
                lessonLookup.get(normalizeLookupValue(task.lessonRef))

            return {
                lessonRef: task.lessonRef,
                lessonId: resolvedLesson?.id ?? null,
                languageCode: task.languageCode?.trim() || 'en',
                setAsDefaultSubtitle: task.setAsDefaultSubtitle ?? true,
                setAsPrimaryForAI: task.setAsPrimaryForAI ?? true,
                status: resolvedLesson ? 'ready' as const : 'unresolved' as const,
            }
        })

        const assetImports: Array<{
            lessonRef: string
            lessonId: string | null
            assetId?: string
            title: string
            assetType: LessonAssetType
            sourceKind: 's3_object'
            sourceBucket: string
            sourceKey: string
            s3Key?: string
            mimeType?: string | null
            url?: string
            status: 'imported' | 'failed'
            error?: string
        }> = []
        const transcriptImports: Array<{
            lessonRef: string
            lessonId: string | null
            videoAssetId?: string
            transcriptAssetId?: string
            textAssetId?: string
            sourceBucket: string
            sourceKey: string
            sourceFormat?: 'TIMESTAMPED_TEXT' | 'PLAIN_TEXT'
            storedFormat?: 'VTT' | 'TEXT'
            cuesCount?: number
            knowledgeProcessing?: {
                status: 'queued' | 'skipped'
                jobId?: string
            }
            status: 'imported' | 'plain_text_imported' | 'skipped' | 'failed'
            warning?: string
            error?: string
        }> = []

        for (const task of input.assetPlan ?? []) {
            if (task.sourceKind !== 's3_object') continue

            const resolvedLesson =
                lessonLookup.get(task.lessonRef) ??
                lessonLookup.get(normalizeLookupValue(task.lessonRef))
            const sourceBucket = task.sourceBucket?.trim() || ''
            const sourceKey = task.sourceKey?.replace(/^\/+/, '') || ''

            if (!resolvedLesson) {
                assetImports.push({
                    lessonRef: task.lessonRef,
                    lessonId: null,
                    title: task.title,
                    assetType: task.assetType,
                    sourceKind: 's3_object',
                    sourceBucket,
                    sourceKey,
                    status: 'failed',
                    error: 'LESSON_REF_UNRESOLVED',
                })
                continue
            }

            try {
                const importedAsset = await ExternalRecordingImportService.importLessonAssetFromS3Object({
                    lessonId: resolvedLesson.id,
                    title: task.title,
                    assetType: task.assetType,
                    source: {
                        bucket: sourceBucket,
                        key: sourceKey,
                        region: task.sourceRegion,
                    },
                    sourceContentType: task.sourceContentType,
                })

                assetImports.push({
                    lessonRef: task.lessonRef,
                    lessonId: resolvedLesson.id,
                    assetId: importedAsset.id,
                    title: importedAsset.title,
                    assetType: importedAsset.type,
                    sourceKind: 's3_object',
                    sourceBucket,
                    sourceKey,
                    s3Key: importedAsset.s3Key,
                    mimeType: importedAsset.mimeType,
                    url: importedAsset.url,
                    status: 'imported',
                })

                const transcriptKey = task.transcriptKey?.replace(/^\/+/, '')
                if (!transcriptKey) continue

                const transcriptBucket = task.transcriptBucket?.trim() || sourceBucket
                if (importedAsset.type !== 'VIDEO') {
                    transcriptImports.push({
                        lessonRef: task.lessonRef,
                        lessonId: resolvedLesson.id,
                        videoAssetId: importedAsset.id,
                        sourceBucket: transcriptBucket,
                        sourceKey: transcriptKey,
                        status: 'skipped',
                        warning: 'TRANSCRIPT_IMPORT_REQUIRES_VIDEO_ASSET',
                    })
                    continue
                }

                try {
                    const importedTranscript = await ExternalRecordingImportService.importTranscriptFromS3Object({
                        lessonId: resolvedLesson.id,
                        videoAssetId: importedAsset.id,
                        source: {
                            bucket: transcriptBucket,
                            key: transcriptKey,
                            region: task.transcriptRegion ?? task.sourceRegion,
                        },
                        transcriptFormat: task.transcriptFormat ?? 'TIMESTAMPED_TEXT',
                        language: task.transcriptLanguage,
                        label: task.transcriptLabel,
                        setAsDefaultSubtitle: task.setTranscriptAsDefaultSubtitle,
                        setAsPrimaryForAI: task.setTranscriptAsPrimaryForAI,
                        processKnowledge: task.processKnowledge ?? true,
                    })

                    transcriptImports.push({
                        lessonRef: task.lessonRef,
                        lessonId: resolvedLesson.id,
                        videoAssetId: importedAsset.id,
                        transcriptAssetId: importedTranscript.transcriptAssetId,
                        textAssetId: importedTranscript.textAssetId,
                        sourceBucket: transcriptBucket,
                        sourceKey: transcriptKey,
                        sourceFormat: importedTranscript.sourceFormat,
                        storedFormat: importedTranscript.storedFormat,
                        cuesCount: importedTranscript.cuesCount,
                        knowledgeProcessing: importedTranscript.knowledgeProcessing,
                        status: importedTranscript.status,
                        warning: importedTranscript.warning,
                    })
                } catch (error) {
                    transcriptImports.push({
                        lessonRef: task.lessonRef,
                        lessonId: resolvedLesson.id,
                        videoAssetId: importedAsset.id,
                        sourceBucket: transcriptBucket,
                        sourceKey: transcriptKey,
                        status: 'failed',
                        error: getErrorMessage(error),
                    })
                }
            } catch (error) {
                assetImports.push({
                    lessonRef: task.lessonRef,
                    lessonId: resolvedLesson.id,
                    title: task.title,
                    assetType: task.assetType,
                    sourceKind: 's3_object',
                    sourceBucket,
                    sourceKey,
                    status: 'failed',
                    error: getErrorMessage(error),
                })
            }
        }

        const warnings: string[] = []
        if (input.mode === 'generate_outline') {
            warnings.push('generate_outline currently creates a scaffolded outline. Review and refine chapter and lesson titles in the course editor if needed.')
        }

        const unresolvedUploadTasks = uploadTasks.filter((task) => task.status === 'unresolved').length
        const unresolvedTranscriptTasks = transcriptTasks.filter((task) => task.status === 'unresolved').length
        if (unresolvedUploadTasks > 0 || unresolvedTranscriptTasks > 0) {
            warnings.push('Some asset or transcript tasks could not be matched to a created lesson. Use the returned lesson IDs or exact lesson titles when planning uploads.')
        }
        if (assetImports.some((item) => item.status === 'failed') || transcriptImports.some((item) => item.status === 'failed')) {
            warnings.push('One or more external S3 imports failed. Check assetImports and transcriptImports for source bucket/key and permission errors.')
        }
        if (transcriptImports.some((item) => item.status === 'skipped')) {
            warnings.push('One or more transcript imports were skipped because the linked imported asset is not a video.')
        }

        return {
            success: true,
            tool: 'design_course',
            summary: `Created ${createdChapters.length} chapters and ${createdLessons.length} lessons for course "${course.title}".`,
            data: {
                course: {
                    id: course.id,
                    title: course.title,
                    slug: course.slug,
                },
                mode: input.mode,
                chaptersCreated: createdChapters,
                lessonsCreated: createdLessons,
                courseStructure: createdChapters.map((chapter) => ({
                    chapterId: chapter.id,
                    chapterTitle: chapter.title,
                    lessons: createdLessons
                        .filter((lesson) => lesson.chapterId === chapter.id)
                        .map((lesson) => ({
                            lessonId: lesson.id,
                            lessonTitle: lesson.title,
                        })),
                })),
                uploadTasks,
                assetImports,
                transcriptImports,
                transcriptTasks,
            },
            nextActions: ['review_event_status'],
            recommendedNextInputs: course.learningEventId
                ? {
                    review_event_status: {
                        event: course.learningEventId,
                    },
                }
                : undefined,
            ...(warnings.length > 0 ? { warnings } : {}),
        }
    }

    static async designExamQuestions(
        user: MappableUser,
        input: {
            exam: string
            mode: 'generate_from_course' | 'generate_from_event' | 'manual_payload'
            sourceCourse?: string | null
            sourceEvent?: string | null
            questionCount?: number
            difficultyMix?: DifficultyLevel | 'mixed'
            questionTypes?: Array<ExamQuestionType>
            choiceOptionCount?: 4 | 5 | 6
            coverageNotes?: string | null
            generateEssayScoringCriteria?: boolean
            essayScoringStyle?: EssayScoringStyle
            requireEssayAiReady?: boolean
            questions?: Array<{
                type: ExamQuestionType
                difficulty?: DifficultyLevel
                question: string
                options?: string[]
                correctAnswer?: string | number | Array<string | number>
                rubric?: string
                sampleAnswer?: string
                gradingCriteria?: Array<{
                    id?: string
                    title: string
                    description?: string | null
                    maxPoints: number
                    guidance?: string | null
                    required?: boolean
                }> | null
                maxWords?: number
                points?: number
                explanation?: string
                topic?: string
                tags?: string[]
            }>
        }
    ): Promise<ToolResult<{
        exam: {
            id: string
            title: string
            learningEventId: string | null
            courseId: string | null
        }
        mode: 'generate_from_course' | 'generate_from_event' | 'manual_payload'
        sourceCourse: {
            id: string
            title: string
            slug: string
        } | null
        questionSummary: {
            totalQuestions: number
            createdThisRun: number
            byType: Record<string, number>
        }
        essayReadiness: {
            totalEssayQuestions: number
            aiReadyEssayQuestions: number
            missingCriteriaCount: number
            missingSampleAnswerCount: number
            criteriaPointMismatchCount: number
            status: 'NOT_APPLICABLE' | 'READY' | 'PARTIAL' | 'NOT_READY'
        }
        scoreSummary: {
            examTotalScore: number
            questionPointsTotal: number
            matchesExamTotal: boolean
        }
    }>> {
        const exam = await this.resolveExamReference(user, input.exam)
        await TrainingOpsService.assertScopedExamAccess(user, exam.id)

        const examRecord = await ExamService.getExamById(exam.id)
        if (!examRecord) {
            throw new Error('EXAM_NOT_FOUND')
        }

        let sourceCourse: CourseReference | null = null
        const warnings: string[] = []
        const effectiveGenerateEssayScoringCriteria =
            input.requireEssayAiReady ? true : input.generateEssayScoringCriteria

        if (input.mode === 'generate_from_course') {
            if (!input.sourceCourse) {
                throw new Error('QUESTION_SOURCE_COURSE_REQUIRED')
            }

            sourceCourse = await this.resolveCourseReference(user, input.sourceCourse)
            await TrainingOpsService.assertScopedCourseAccess(user, sourceCourse.id)
        }

        if (input.mode === 'generate_from_event') {
            if (!input.sourceEvent) {
                throw new Error('QUESTION_SOURCE_EVENT_REQUIRED')
            }

            const sourceEvent = await this.resolveEventReference(user, input.sourceEvent)
            const linkedCourses = (await TrainingOpsService.getScopedCourses(user)).filter(
                (course) => course.learningEventId === sourceEvent.id
            )

            if (linkedCourses.length === 0) {
                throw errorWithDetails('EVENT_LINKED_COURSE_NOT_FOUND', {
                    eventId: sourceEvent.id,
                    title: sourceEvent.title,
                })
            }

            if (linkedCourses.length > 1) {
                throw errorWithDetails('EVENT_LINKED_COURSE_AMBIGUOUS', {
                    eventId: sourceEvent.id,
                    title: sourceEvent.title,
                    candidates: linkedCourses.map((course) => ({
                        id: course.id,
                        title: course.title,
                        slug: course.slug,
                    })),
                })
            }

            sourceCourse = linkedCourses[0]
        }

        if (sourceCourse && examRecord.courseId !== sourceCourse.id) {
            await ExamService.updateExam(
                exam.id,
                { courseId: sourceCourse.id },
                { actorRole: user.role }
            )
        }

        const beforeQuestions = await ExamService.getQuestions(exam.id)
        const beforeQuestionIds = new Set(beforeQuestions.map((question) => String(question.id)))

        if (input.mode === 'manual_payload') {
            for (const question of input.questions ?? []) {
                const points = question.points ?? 10
                const normalizedCorrectAnswer = normalizeManualCorrectAnswer(
                    question.type,
                    question.correctAnswer,
                    question.options
                )
                const essaySupport = question.type === ExamQuestionType.ESSAY
                    ? buildEssayQuestionSupport({
                        question: question.question,
                        points,
                        rubric: question.rubric,
                        sampleAnswer: question.sampleAnswer,
                        gradingCriteria: question.gradingCriteria,
                        essayScoringStyle: input.essayScoringStyle,
                        generateEssayScoringCriteria: effectiveGenerateEssayScoringCriteria,
                    })
                    : null

                if (essaySupport && input.requireEssayAiReady) {
                    if (!essaySupport.gradingCriteria || essaySupport.gradingCriteria.length === 0) {
                        throw errorWithDetails('ESSAY_SCORING_CRITERIA_REQUIRED', {
                            question: question.question,
                        })
                    }

                    if (!essaySupport.sampleAnswer) {
                        throw errorWithDetails('ESSAY_SAMPLE_ANSWER_REQUIRED', {
                            question: question.question,
                        })
                    }
                }

                await ExamService.addQuestion(exam.id, {
                    type: question.type,
                    difficulty: question.difficulty ?? DifficultyLevel.MEDIUM,
                    question: question.question,
                    options: question.options,
                    correctAnswer: normalizedCorrectAnswer,
                    rubric: essaySupport?.rubric ?? question.rubric,
                    sampleAnswer: essaySupport?.sampleAnswer ?? question.sampleAnswer,
                    gradingCriteria:
                        essaySupport?.gradingCriteria ??
                        (question.gradingCriteria
                            ? parseEssayGradingCriteria(question.gradingCriteria)
                            : undefined),
                    maxWords: question.maxWords,
                    points,
                    explanation: question.explanation,
                    topic: question.topic,
                    tags: question.tags,
                })
            }
        } else {
            const questionTypes = input.questionTypes && input.questionTypes.length > 0
                ? input.questionTypes
                : [ExamQuestionType.SINGLE_CHOICE]
            const questionCount =
                input.questionCount ??
                Math.max(1, Math.round((examRecord.totalScore ?? 100) / 10))

            const questionCounts: {
                singleChoice?: number
                multipleChoice?: number
                trueFalse?: number
                fillInBlank?: number
                essay?: number
            } = {}

            questionTypes.forEach((type, index) => {
                const base = Math.floor(questionCount / questionTypes.length)
                const remainder = index < questionCount % questionTypes.length ? 1 : 0
                const assignedCount = base + remainder
                if (assignedCount <= 0) return

                switch (type) {
                    case ExamQuestionType.SINGLE_CHOICE:
                        questionCounts.singleChoice = (questionCounts.singleChoice ?? 0) + assignedCount
                        break
                    case ExamQuestionType.MULTIPLE_CHOICE:
                        questionCounts.multipleChoice = (questionCounts.multipleChoice ?? 0) + assignedCount
                        break
                    case ExamQuestionType.TRUE_FALSE:
                        questionCounts.trueFalse = (questionCounts.trueFalse ?? 0) + assignedCount
                        break
                    case ExamQuestionType.FILL_IN_BLANK:
                        questionCounts.fillInBlank = (questionCounts.fillInBlank ?? 0) + assignedCount
                        break
                    case ExamQuestionType.ESSAY:
                        questionCounts.essay = (questionCounts.essay ?? 0) + assignedCount
                        break
                    default:
                        questionCounts.singleChoice = (questionCounts.singleChoice ?? 0) + assignedCount
                        warnings.push(`Question type "${type}" is not supported by the generator, so it was mapped to SINGLE_CHOICE.`)
                        break
                }
            })

            const focusAreas = input.coverageNotes
                ? input.coverageNotes
                    .split(/[\n,;]+/)
                    .map((item) => item.trim())
                    .filter(Boolean)
                : undefined

            const generationService = new ExamGenerationService()
            const generationResult = await generationService.generateQuestions(exam.id, {
                questionCounts,
                difficulty: input.difficultyMix ?? 'mixed',
                choiceOptionCount: input.choiceOptionCount,
                focusAreas,
                topics: focusAreas,
                generateEssayScoringCriteria: effectiveGenerateEssayScoringCriteria,
                essayScoringStyle: input.essayScoringStyle,
            })

            warnings.push(...generationResult.warnings)
        }

        const questions = await ExamService.getQuestions(exam.id)
        const createdThisRun = questions.filter((question) => !beforeQuestionIds.has(String(question.id)))
        const byType = questions.reduce<Record<string, number>>((acc, question) => {
            const key = String(question.type)
            acc[key] = (acc[key] ?? 0) + 1
            return acc
        }, {})
        const questionPointsTotal = questions.reduce((sum, question) => sum + (Number(question.points) || 0), 0)
        const essayQuestions = questions.filter((question) => question.type === ExamQuestionType.ESSAY)
        const essayReadiness = essayQuestions.reduce(
            (acc, question) => {
                const criteria = parseEssayGradingCriteria(question.gradingCriteria)
                const hasCriteria = criteria.length > 0
                const hasSampleAnswer = Boolean(optionalText(question.sampleAnswer))
                const criteriaPointMismatch =
                    hasCriteria && sumEssayGradingCriteriaPoints(criteria) !== (Number(question.points) || 0)

                acc.totalEssayQuestions += 1
                if (hasCriteria && hasSampleAnswer && !criteriaPointMismatch) {
                    acc.aiReadyEssayQuestions += 1
                }
                if (!hasCriteria) acc.missingCriteriaCount += 1
                if (!hasSampleAnswer) acc.missingSampleAnswerCount += 1
                if (criteriaPointMismatch) acc.criteriaPointMismatchCount += 1
                return acc
            },
            {
                totalEssayQuestions: 0,
                aiReadyEssayQuestions: 0,
                missingCriteriaCount: 0,
                missingSampleAnswerCount: 0,
                criteriaPointMismatchCount: 0,
            }
        )

        const essayReadinessStatus =
            essayReadiness.totalEssayQuestions === 0
                ? 'NOT_APPLICABLE'
                : essayReadiness.aiReadyEssayQuestions === essayReadiness.totalEssayQuestions
                    ? 'READY'
                    : essayReadiness.aiReadyEssayQuestions === 0
                        ? 'NOT_READY'
                        : 'PARTIAL'

        if (questionPointsTotal !== examRecord.totalScore) {
            warnings.push(
                `Question points total is ${questionPointsTotal}, while the exam totalScore is ${examRecord.totalScore}. Update the exam or question points before publishing.`
            )
        }

        if (essayReadiness.missingCriteriaCount > 0) {
            warnings.push(
                `${essayReadiness.missingCriteriaCount} essay question(s) are missing structured scoring points.`
            )
        }

        if (essayReadiness.missingSampleAnswerCount > 0) {
            warnings.push(
                `${essayReadiness.missingSampleAnswerCount} essay question(s) are missing sample answers for AI-assisted grading.`
            )
        }

        if (essayReadiness.criteriaPointMismatchCount > 0) {
            warnings.push(
                `${essayReadiness.criteriaPointMismatchCount} essay question(s) have scoring-point totals that do not match the question points.`
            )
        }

        if (input.requireEssayAiReady && essayReadinessStatus !== 'READY' && essayReadinessStatus !== 'NOT_APPLICABLE') {
            throw errorWithDetails('ESSAY_AI_GRADING_NOT_READY', essayReadiness)
        }

        return {
            success: true,
            tool: 'design_exam_questions',
            summary: `Added ${createdThisRun.length} questions to exam "${examRecord.title}".`,
            data: {
                exam: {
                    id: examRecord.id,
                    title: examRecord.title,
                    learningEventId: examRecord.learningEventId ?? null,
                    courseId: sourceCourse?.id ?? examRecord.courseId ?? null,
                },
                mode: input.mode,
                sourceCourse: sourceCourse
                    ? {
                        id: sourceCourse.id,
                        title: sourceCourse.title,
                        slug: sourceCourse.slug,
                    }
                    : null,
                questionSummary: {
                    totalQuestions: questions.length,
                    createdThisRun: createdThisRun.length,
                    byType,
                },
                essayReadiness: {
                    ...essayReadiness,
                    status: essayReadinessStatus,
                },
                scoreSummary: {
                    examTotalScore: examRecord.totalScore,
                    questionPointsTotal,
                    matchesExamTotal: questionPointsTotal === examRecord.totalScore,
                },
            },
            nextActions: ['review_event_status', 'publish_exam_for_learners'],
            recommendedNextInputs: examRecord.learningEventId
                ? {
                    review_event_status: {
                        event: examRecord.learningEventId,
                    },
                    publish_exam_for_learners: {
                        exam: examRecord.id,
                        userIds: [],
                        sendNotification: false,
                    },
                }
                : undefined,
            ...(warnings.length > 0 ? { warnings } : {}),
        }
    }

    static async reviewEventStatus(
        user: MappableUser,
        input: {
            event: string
        }
    ) {
        const event = await this.resolveEventReference(user, input.event)
        const result = await this.getEventExecutionStatus(user, { eventId: event.id })
        const nextActions = new Set<string>()
        const recommendedNextInputs: Record<string, unknown> = {}

        const singleCourse = result.data.courses.length === 1 ? result.data.courses[0] : null
        const singleExam = result.data.exams.length === 1 ? result.data.exams[0] : null
        const publishableExam = result.data.exams.find((exam) => exam.status !== ExamStatus.PUBLISHED && exam.publishPreconditionsMet) ?? null

        if (result.data.courses.length === 0) {
            nextActions.add('create_course')
            recommendedNextInputs.create_course = {
                event: event.id,
            }
        }

        if (result.data.exams.length === 0) {
            nextActions.add('create_exam')
            recommendedNextInputs.create_exam = {
                event: event.id,
                examType: 'PRACTICE',
                totalScore: 100,
                passingScore: 80,
                maxAttempts: 3,
            }
        }

        if (result.data.courses.length > 0 && result.data.lessonStates.length === 0) {
            nextActions.add('design_course')
            if (singleCourse) {
                recommendedNextInputs.design_course = {
                    course: singleCourse.id,
                    mode: 'generate_outline',
                    brief: `Design a starter outline for ${singleCourse.title}.`,
                }
            }
        }

        if (result.data.exams.some((exam) => exam.questionCount === 0)) {
            nextActions.add('design_exam_questions')
            if (singleExam) {
                recommendedNextInputs.design_exam_questions = singleCourse
                    ? {
                        exam: singleExam.id,
                        mode: 'generate_from_course',
                        sourceCourse: singleCourse.id,
                        questionCount: Math.max(1, Math.round(singleExam.totalScore / 10)),
                    }
                    : {
                        exam: singleExam.id,
                        mode: 'manual_payload',
                        questions: [],
                    }
            }
        }

        if (singleCourse && singleCourse.status === CourseStatus.PUBLISHED && singleCourse.enrolledCount === 0) {
            nextActions.add('share_course_with_learners')
            recommendedNextInputs.share_course_with_learners = {
                course: singleCourse.id,
                userIds: [],
                sendNotification: false,
            }
        }

        if (publishableExam) {
            nextActions.add('publish_exam_for_learners')
            recommendedNextInputs.publish_exam_for_learners = {
                exam: publishableExam.id,
                userIds: [],
                sendNotification: false,
            }
        }

        const warnings = [...(result.warnings ?? [])]
        if (result.data.transcriptStatus.lessonsMissingTranscript > 0 || result.data.knowledgeStatus.missingLessons > 0) {
            warnings.push('Transcript and knowledge processing remain available as advanced tools if this event needs subtitles or AI knowledge extraction.')
        }

        if (nextActions.size === 0) {
            nextActions.add('list_my_workspace')
        }

        return {
            ...result,
            tool: 'review_event_status',
            nextActions: Array.from(nextActions),
            recommendedNextInputs: Object.keys(recommendedNextInputs).length > 0 ? recommendedNextInputs : undefined,
            ...(warnings.length > 0 ? { warnings } : {}),
        }
    }

    static async getEventExecutionStatus(
        user: MappableUser,
        input: {
            eventId: string
        }
    ): Promise<ToolResult<{
        event: Awaited<ReturnType<typeof TrainingOpsService.getScopedLearningEventById>>
        courses: Awaited<ReturnType<typeof TrainingOpsService.getScopedLearningEventById>>['courses']
        exams: Array<{
            id: string
            title: string
            status: ExamStatus
            publishedAt: Date | null
            totalScore: number
            questionCount: number
            questionPoints: number
            essayQuestionCount: number
            essayQuestionsAiReadyCount: number
            essayQuestionsMissingCriteriaCount: number
            essayQuestionsMissingSampleAnswerCount: number
            essayCriteriaPointMismatchCount: number
            aiGradingReadiness: 'NOT_APPLICABLE' | 'READY' | 'PARTIAL' | 'NOT_READY'
            invitationCount: number
            attemptCount: number
            gradedAttemptCount: number
            passedCount: number
            failedCount: number
            passRate: number
            publishPreconditionsMet: boolean
            blockers: string[]
        }>
        transcriptStatus: {
            totalLessons: number
            lessonsWithTranscript: number
            lessonsMissingTranscript: number
            readyLessons: number
            processingLessons: number
            failedLessons: number
            activeJobs: number
        }
        knowledgeStatus: {
            totalLessons: number
            readyLessons: number
            missingLessons: number
            processingLessons: number
            failedLessons: number
            activeJobs: number
        }
        invitationStatus: {
            courseEnrollmentCount: number
            examInvitationCount: number
            examAttemptCount: number
            gradedAttemptCount: number
            passedCount: number
            failedCount: number
            passRate: number
        }
        lessonStates: Array<{
            lessonId: string
            lessonTitle: string
            courseId: string
            courseTitle: string
            videoAssets: Array<{
                id: string
                title: string
                mimeType: string | null
            }>
            transcriptTracks: Array<{
                id: string
                status: string
                language: string
                isPrimaryForAI: boolean
                isDefaultSubtitle: boolean
            }>
            transcript: {
                id: string
                status: string
                language: string
                isPrimaryForAI: boolean
                isDefaultSubtitle: boolean
                latestJob: {
                    id: string
                    state: string
                    stage: string
                    errorMessage: string | null
                } | null
            } | null
            knowledge: {
                status: string
                latestJob: {
                    id: string
                    state: string
                    stage: string
                    errorMessage: string | null
                } | null
            }
            recommendedNextInputs: {
                prepare_transcript_upload: {
                    lessonId: string
                    contentType: 'text/vtt'
                    videoAssetId?: string
                }
                process_transcript_knowledge: {
                    lessonId: string
                    processTranscript: boolean
                    processKnowledge: boolean
                    transcriptId?: string
                }
            }
        }>
    }>> {
        const event = await TrainingOpsService.getScopedLearningEventById(user, input.eventId)
        const warnings: string[] = []

        if (event.courses.length > 1) {
            warnings.push(`Event "${event.title}" has ${event.courses.length} linked courses.`)
        }

        if (event.exams.length > 1) {
            warnings.push(`Event "${event.title}" has ${event.exams.length} linked exams.`)
        }

        const linkedExamIds = event.exams.map((exam) => exam.id)
        const [examQuestionStats, essayQuestions, examDetails, lessons] = await Promise.all([
            linkedExamIds.length > 0
                ? prisma.examQuestion.groupBy({
                    by: ['examId'],
                    where: {
                        examId: { in: linkedExamIds },
                        archivedAt: null,
                    },
                    _count: {
                        _all: true,
                    },
                    _sum: {
                        points: true,
                    },
                })
                : Promise.resolve([]),
            linkedExamIds.length > 0
                ? prisma.examQuestion.findMany({
                    where: {
                        examId: { in: linkedExamIds },
                        archivedAt: null,
                        type: ExamQuestionType.ESSAY,
                    },
                    select: {
                        examId: true,
                        sampleAnswer: true,
                        gradingCriteria: true,
                        points: true,
                    },
                })
                : Promise.resolve([]),
            linkedExamIds.length > 0
                ? prisma.exam.findMany({
                    where: {
                        id: { in: linkedExamIds },
                    },
                    select: {
                        id: true,
                        title: true,
                        status: true,
                        publishedAt: true,
                        totalScore: true,
                    },
                })
                : Promise.resolve([]),
            prisma.lesson.findMany({
                where: {
                    chapter: {
                        course: {
                            learningEventId: input.eventId,
                        },
                    },
                },
                select: {
                    id: true,
                    title: true,
                    chapter: {
                        select: {
                            course: {
                                select: {
                                    id: true,
                                    title: true,
                                },
                            },
                        },
                    },
                    transcripts: {
                        where: {
                            isActive: true,
                            archivedAt: null,
                        },
                        orderBy: [{ isPrimaryForAI: 'desc' }, { isDefaultSubtitle: 'desc' }, { createdAt: 'asc' }],
                        select: {
                            id: true,
                            language: true,
                            status: true,
                            isPrimaryForAI: true,
                            isDefaultSubtitle: true,
                            processingJobs: {
                                orderBy: {
                                    createdAt: 'desc',
                                },
                                take: 1,
                                select: {
                                    id: true,
                                    state: true,
                                    stage: true,
                                    errorMessage: true,
                                },
                            },
                        },
                    },
                    assets: {
                        where: {
                            courseAsset: {
                                type: 'VIDEO',
                            },
                        },
                        select: {
                            courseAsset: {
                                select: {
                                    id: true,
                                    title: true,
                                    mimeType: true,
                                    contentType: true,
                                },
                            },
                        },
                    },
                    knowledgeContext: {
                        select: {
                            status: true,
                            errorMessage: true,
                        },
                    },
                    knowledgeContextJobs: {
                        orderBy: {
                            createdAt: 'desc',
                        },
                        take: 1,
                        select: {
                            id: true,
                            state: true,
                            stage: true,
                            errorMessage: true,
                        },
                    },
                },
            }),
        ])

        const examQuestionStatsByExamId = new Map(
            examQuestionStats.map((row) => [
                row.examId,
                {
                    questionCount: row._count._all,
                    questionPoints: row._sum.points ?? 0,
                },
            ])
        )
        const essayReadinessByExamId = new Map<string, {
            essayQuestionCount: number
            essayQuestionsAiReadyCount: number
            essayQuestionsMissingCriteriaCount: number
            essayQuestionsMissingSampleAnswerCount: number
            essayCriteriaPointMismatchCount: number
        }>()
        for (const row of essayQuestions) {
            const existing = essayReadinessByExamId.get(row.examId) ?? {
                essayQuestionCount: 0,
                essayQuestionsAiReadyCount: 0,
                essayQuestionsMissingCriteriaCount: 0,
                essayQuestionsMissingSampleAnswerCount: 0,
                essayCriteriaPointMismatchCount: 0,
            }
            const criteria = parseEssayGradingCriteria(row.gradingCriteria)
            const hasCriteria = criteria.length > 0
            const hasSampleAnswer = Boolean(optionalText(row.sampleAnswer))
            const criteriaPointMismatch =
                hasCriteria && sumEssayGradingCriteriaPoints(criteria) !== (Number(row.points) || 0)

            existing.essayQuestionCount += 1
            if (hasCriteria && hasSampleAnswer && !criteriaPointMismatch) {
                existing.essayQuestionsAiReadyCount += 1
            }
            if (!hasCriteria) existing.essayQuestionsMissingCriteriaCount += 1
            if (!hasSampleAnswer) existing.essayQuestionsMissingSampleAnswerCount += 1
            if (criteriaPointMismatch) existing.essayCriteriaPointMismatchCount += 1

            essayReadinessByExamId.set(row.examId, existing)
        }
        const eventExamStatsById = new Map(event.exams.map((exam) => [exam.id, exam]))

        const exams = examDetails.map((exam) => {
            const questionStats = examQuestionStatsByExamId.get(exam.id) ?? {
                questionCount: 0,
                questionPoints: 0,
            }
            const essayReadiness = essayReadinessByExamId.get(exam.id) ?? {
                essayQuestionCount: 0,
                essayQuestionsAiReadyCount: 0,
                essayQuestionsMissingCriteriaCount: 0,
                essayQuestionsMissingSampleAnswerCount: 0,
                essayCriteriaPointMismatchCount: 0,
            }
            const operationalStats = eventExamStatsById.get(exam.id)
            const blockers: string[] = []

            if (exam.status !== ExamStatus.APPROVED && exam.status !== ExamStatus.PUBLISHED) {
                blockers.push('Exam must be APPROVED before publishing.')
            }

            if (questionStats.questionCount === 0) {
                blockers.push('Exam has no active questions.')
            }

            if (questionStats.questionPoints !== exam.totalScore) {
                blockers.push('Exam question points do not match the configured exam total score.')
            }

            const aiGradingReadiness: 'NOT_APPLICABLE' | 'READY' | 'PARTIAL' | 'NOT_READY' =
                essayReadiness.essayQuestionCount === 0
                    ? 'NOT_APPLICABLE'
                    : essayReadiness.essayQuestionsAiReadyCount === essayReadiness.essayQuestionCount
                        ? 'READY'
                        : essayReadiness.essayQuestionsAiReadyCount === 0
                            ? 'NOT_READY'
                            : 'PARTIAL'

            return {
                id: exam.id,
                title: exam.title,
                status: exam.status,
                publishedAt: exam.publishedAt,
                totalScore: exam.totalScore,
                questionCount: questionStats.questionCount,
                questionPoints: questionStats.questionPoints,
                essayQuestionCount: essayReadiness.essayQuestionCount,
                essayQuestionsAiReadyCount: essayReadiness.essayQuestionsAiReadyCount,
                essayQuestionsMissingCriteriaCount: essayReadiness.essayQuestionsMissingCriteriaCount,
                essayQuestionsMissingSampleAnswerCount: essayReadiness.essayQuestionsMissingSampleAnswerCount,
                essayCriteriaPointMismatchCount: essayReadiness.essayCriteriaPointMismatchCount,
                aiGradingReadiness,
                invitationCount: operationalStats?.invitationCount ?? 0,
                attemptCount: operationalStats?.attemptCount ?? 0,
                gradedAttemptCount: operationalStats?.gradedAttemptCount ?? 0,
                passedCount: operationalStats?.passedCount ?? 0,
                failedCount: operationalStats?.failedCount ?? 0,
                passRate: operationalStats?.passRate ?? 0,
                publishPreconditionsMet: blockers.length === 0,
                blockers,
            }
        })

        for (const exam of exams) {
            if (exam.essayQuestionsMissingCriteriaCount > 0) {
                warnings.push(
                    `Exam "${exam.title}" has ${exam.essayQuestionsMissingCriteriaCount} essay question(s) missing structured scoring points for AI-assisted grading.`
                )
            }

            if (exam.essayQuestionsMissingSampleAnswerCount > 0) {
                warnings.push(
                    `Exam "${exam.title}" has ${exam.essayQuestionsMissingSampleAnswerCount} essay question(s) missing sample answers for AI-assisted grading.`
                )
            }

            if (exam.essayCriteriaPointMismatchCount > 0) {
                warnings.push(
                    `Exam "${exam.title}" has ${exam.essayCriteriaPointMismatchCount} essay question(s) whose scoring-point totals do not match the configured question points.`
                )
            }
        }

        const lessonStates = lessons.map((lesson) => {
            const transcript = getPrimaryAiTranscriptTrack(lesson.transcripts)
            const transcriptJob = transcript?.processingJobs[0] ?? null
            const knowledgeJob = lesson.knowledgeContextJobs[0] ?? null
            const transcriptTracks = lesson.transcripts.map((track) => ({
                id: track.id,
                status: track.status,
                language: track.language,
                isPrimaryForAI: track.isPrimaryForAI,
                isDefaultSubtitle: track.isDefaultSubtitle,
            }))
            const videoAssets = lesson.assets.map((binding) => ({
                id: binding.courseAsset.id,
                title: binding.courseAsset.title,
                mimeType: binding.courseAsset.mimeType ?? binding.courseAsset.contentType ?? null,
            }))
            const singleVideoAsset = videoAssets.length === 1 ? videoAssets[0] : null

            return {
                lessonId: lesson.id,
                lessonTitle: lesson.title,
                courseId: lesson.chapter.course.id,
                courseTitle: lesson.chapter.course.title,
                videoAssets,
                transcriptTracks,
                transcript: transcript
                    ? {
                        id: transcript.id,
                        status: transcript.status,
                        language: transcript.language,
                        isPrimaryForAI: transcript.isPrimaryForAI,
                        isDefaultSubtitle: transcript.isDefaultSubtitle,
                        latestJob: transcriptJob
                            ? {
                                id: transcriptJob.id,
                                state: transcriptJob.state,
                                stage: transcriptJob.stage,
                                errorMessage: transcriptJob.errorMessage,
                            }
                            : null,
                    }
                    : null,
                knowledge: {
                    status: lesson.knowledgeContext?.status ?? 'MISSING',
                    latestJob: knowledgeJob
                        ? {
                            id: knowledgeJob.id,
                            state: knowledgeJob.state,
                            stage: knowledgeJob.stage,
                            errorMessage: knowledgeJob.errorMessage,
                            }
                            : null,
                },
                recommendedNextInputs: {
                    prepare_transcript_upload: singleVideoAsset
                        ? {
                            lessonId: lesson.id,
                            videoAssetId: singleVideoAsset.id,
                            contentType: 'text/vtt' as const,
                        }
                        : {
                            lessonId: lesson.id,
                            contentType: 'text/vtt' as const,
                        },
                    process_transcript_knowledge: transcript
                        ? {
                            lessonId: lesson.id,
                            transcriptId: transcript.id,
                            processTranscript: true,
                            processKnowledge: true,
                        }
                        : {
                            lessonId: lesson.id,
                            processTranscript: true,
                            processKnowledge: true,
                        },
                },
            }
        })

        const transcriptStatus = lessonStates.reduce(
            (summary, lesson) => {
                summary.totalLessons += 1

                if (!lesson.transcript) {
                    summary.lessonsMissingTranscript += 1
                    return summary
                }

                summary.lessonsWithTranscript += 1

                if (lesson.transcript.status === 'READY') {
                    summary.readyLessons += 1
                }

                if (lesson.transcript.status === 'FAILED') {
                    summary.failedLessons += 1
                }

                if (
                    lesson.transcript.latestJob &&
                    ['QUEUED', 'RUNNING', 'RETRY_WAIT'].includes(lesson.transcript.latestJob.state)
                ) {
                    summary.processingLessons += 1
                    summary.activeJobs += 1
                }

                return summary
            },
            {
                totalLessons: 0,
                lessonsWithTranscript: 0,
                lessonsMissingTranscript: 0,
                readyLessons: 0,
                processingLessons: 0,
                failedLessons: 0,
                activeJobs: 0,
            }
        )

        const knowledgeStatus = lessonStates.reduce(
            (summary, lesson) => {
                summary.totalLessons += 1

                if (lesson.knowledge.status === 'READY') {
                    summary.readyLessons += 1
                } else if (lesson.knowledge.status === 'FAILED') {
                    summary.failedLessons += 1
                } else if (lesson.knowledge.status === 'MISSING') {
                    summary.missingLessons += 1
                }

                if (
                    lesson.knowledge.latestJob &&
                    ['QUEUED', 'RUNNING', 'RETRY_WAIT'].includes(lesson.knowledge.latestJob.state)
                ) {
                    summary.processingLessons += 1
                    summary.activeJobs += 1
                }

                return summary
            },
            {
                totalLessons: 0,
                readyLessons: 0,
                missingLessons: 0,
                processingLessons: 0,
                failedLessons: 0,
                activeJobs: 0,
            }
        )

        if (event.courses.length > 0 && lessonStates.length === 0) {
            warnings.push(`Event "${event.title}" has linked course content, but no lessons are currently attached.`)
        }

        const nextActions = new Set<string>()
        if (event.courses.length === 0) nextActions.add('create_course')
        if (event.exams.length === 0) nextActions.add('create_exam')
        if (event.courses.length > 0 && lessonStates.length === 0) nextActions.add('design_course')
        if (transcriptStatus.lessonsMissingTranscript > 0) nextActions.add('prepare_transcript_upload')
        if (
            lessonStates.some((lesson) => lesson.transcript !== null && lesson.knowledge.status !== 'READY')
        ) {
            nextActions.add('process_transcript_knowledge')
        }
        if (exams.some((exam) => exam.status !== ExamStatus.PUBLISHED && exam.publishPreconditionsMet)) {
            nextActions.add('publish_exam_for_learners')
        }
        if (nextActions.size === 0) {
            nextActions.add('list_my_workspace')
        }

        return {
            success: true,
            tool: 'get_event_execution_status',
            summary: `Returned execution status for event "${event.title}".`,
            data: {
                event,
                courses: event.courses,
                exams,
                transcriptStatus,
                knowledgeStatus,
                invitationStatus: {
                    courseEnrollmentCount: event.courses.reduce((sum, course) => sum + course.enrolledCount, 0),
                    examInvitationCount: event.analytics?.invitationCount ?? 0,
                    examAttemptCount: event.analytics?.attemptCount ?? 0,
                    gradedAttemptCount: event.analytics?.gradedAttemptCount ?? 0,
                    passedCount: event.analytics?.passedCount ?? 0,
                    failedCount: event.analytics?.failedCount ?? 0,
                    passRate: event.analytics?.passRate ?? 0,
                },
                lessonStates,
            },
            nextActions: Array.from(nextActions),
            ...(warnings.length > 0 ? { warnings } : {}),
        }
    }

    static async listMySeriesBadges(user: MappableUser): Promise<ToolResult<Awaited<ReturnType<typeof TrainingOpsService.getScopedBadgeLadders>>>> {
        const data = await TrainingOpsService.getScopedBadgeLadders(user)

        return {
            success: true,
            tool: 'list_my_series_badges',
            summary: `Returned domain badge progressions for ${data.domains.length} scoped domains.`,
            data,
            nextActions: ['list_my_workspace', 'create_badge', 'create_learning_program'],
        }
    }

    static async publishExamWithInvitations(
        user: MappableUser,
        input: {
            examId: string
            userIds: string[]
            sendNotification?: boolean
        }
    ): Promise<ToolResult<{
        exam: {
            id: string
            title: string
            status: ExamStatus
            publishedAt: Date | null
            invitationCount: number
        }
        invitationsCreated: number
        invitationsSkipped: number
        notificationsSent: number
        notificationsFailed: number
        retroactiveStarAwardsIssued: number
        retroactiveStarsGranted: number
        retroactiveBadgesUnlocked: number
    }>> {
        await TrainingOpsService.assertScopedExamAccess(user, input.examId)

        const exam = await prisma.exam.findUnique({
            where: { id: input.examId },
            select: {
                id: true,
                title: true,
                status: true,
                totalScore: true,
            },
        })

        if (!exam) {
            throw new Error('EXAM_NOT_FOUND')
        }

        if (exam.status !== ExamStatus.APPROVED) {
            throw new Error('EXAM_NOT_APPROVED')
        }

        await DomainGovernanceService.assertExamPublishable(input.examId)

        const activeQuestionCount = await prisma.examQuestion.count({
            where: { examId: input.examId, archivedAt: null },
        })

        if (activeQuestionCount === 0) {
            throw new Error('EXAM_HAS_NO_QUESTIONS')
        }

        const sum = await prisma.examQuestion.aggregate({
            where: { examId: input.examId, archivedAt: null },
            _sum: { points: true },
        })

        const totalPoints = sum._sum.points ?? 0
        if (totalPoints !== exam.totalScore) {
            throw new Error('EXAM_TOTAL_SCORE_MISMATCH')
        }

        const existingInvitationCount = await prisma.examInvitation.count({
            where: { examId: input.examId },
        })

        if (input.userIds.length === 0 && existingInvitationCount === 0) {
            throw new Error('EXAM_INVITATIONS_REQUIRED')
        }

        const users = input.userIds.length > 0
            ? await prisma.user.findMany({
                where: { id: { in: input.userIds }, status: 'ACTIVE' },
                select: { id: true },
            })
            : []

        const activeUserIds = new Set(users.map((item) => item.id))
        const invalidUserIds = input.userIds.filter((id) => !activeUserIds.has(id))
        if (invalidUserIds.length > 0) {
            throw new Error(`INVALID_INVITATION_USERS:${invalidUserIds.join(',')}`)
        }

        const existingInvites = input.userIds.length > 0
            ? await prisma.examInvitation.findMany({
                where: {
                    examId: input.examId,
                    userId: { in: input.userIds },
                },
                select: { userId: true },
            })
            : []
        const existingSet = new Set(existingInvites.map((item) => item.userId))
        const toCreate = input.userIds.filter((id) => !existingSet.has(id))

        const rewardBackfill = await prisma.$transaction(async (tx) => {
            if (toCreate.length > 0) {
                await tx.examInvitation.createMany({
                    data: toCreate.map((userId) => ({ examId: input.examId, userId })),
                    skipDuplicates: true,
                })
            }

            await tx.exam.update({
                where: { id: input.examId },
                data: {
                    status: ExamStatus.PUBLISHED,
                    publishedAt: new Date(),
                },
            })

            return TrainingOpsRewardService.issueMissingRewardsForPublishedExam(input.examId, tx)
        })

        const notificationResults = { sent: 0, failed: 0 }
        if (input.sendNotification && toCreate.length > 0) {
            for (const userId of toCreate) {
                const result = await WecomWebhookService.sendExamInvitation(userId, input.examId)
                if (result.success) notificationResults.sent++
                else notificationResults.failed++
            }
        }

        const updatedExam = await prisma.exam.findUnique({
            where: { id: input.examId },
            select: {
                id: true,
                title: true,
                status: true,
                publishedAt: true,
                learningEventId: true,
                _count: {
                    select: {
                        invitations: true,
                    },
                },
            },
        })

        return {
            success: true,
            tool: 'publish_exam_with_invitations',
            summary: `Published "${updatedExam?.title ?? exam.title}" and created ${toCreate.length} invitations. Retroactive stars issued: ${rewardBackfill.starAwardsIssued}.`,
            data: {
                exam: {
                    id: updatedExam?.id ?? exam.id,
                    title: updatedExam?.title ?? exam.title,
                    status: updatedExam?.status ?? ExamStatus.PUBLISHED,
                    publishedAt: updatedExam?.publishedAt ?? new Date(),
                    invitationCount: updatedExam?._count.invitations ?? existingInvitationCount + toCreate.length,
                },
                invitationsCreated: toCreate.length,
                invitationsSkipped: input.userIds.length - toCreate.length,
                notificationsSent: notificationResults.sent,
                notificationsFailed: notificationResults.failed,
                retroactiveStarAwardsIssued: rewardBackfill.starAwardsIssued,
                retroactiveStarsGranted: rewardBackfill.starsGranted,
                retroactiveBadgesUnlocked: rewardBackfill.newBadges,
            },
            nextActions: updatedExam?.learningEventId ? ['review_event_status', 'list_my_workspace'] : ['list_my_workspace'],
            recommendedNextInputs: updatedExam?.learningEventId
                ? {
                    review_event_status: {
                        event: updatedExam.learningEventId,
                    },
                }
                : undefined,
        }
    }

    static async assignCourseInvitations(
        user: MappableUser,
        input: {
            courseId: string
            userIds: string[]
            sendNotification?: boolean
        }
    ): Promise<ToolResult<{
        course: {
            id: string
            title: string
            status: string
        }
        invitationsCreated: number
        invitationsSkipped: number
        notificationsSent: number
        notificationsFailed: number
    }>> {
        await TrainingOpsService.assertScopedCourseAccess(user, input.courseId)

        const parsed = inviteUsersSchema.parse({
            userIds: input.userIds,
            sendNotification: input.sendNotification,
        })

        const course = await prisma.course.findUnique({
            where: { id: input.courseId },
            select: {
                id: true,
                title: true,
                status: true,
                learningEventId: true,
            },
        })

        if (!course) {
            throw new Error('COURSE_NOT_FOUND')
        }

        if (course.status !== 'PUBLISHED') {
            throw new Error('COURSE_NOT_PUBLISHED')
        }

        const users = await prisma.user.findMany({
            where: {
                id: { in: parsed.userIds },
                status: 'ACTIVE',
            },
            select: { id: true },
        })
        const activeUserIds = new Set(users.map((row) => row.id))
        const invalidUserIds = parsed.userIds.filter((id) => !activeUserIds.has(id))
        if (invalidUserIds.length > 0) {
            throw new Error(`INVALID_COURSE_INVITATION_USERS:${invalidUserIds.join(',')}`)
        }

        const existing = await prisma.enrollment.findMany({
            where: {
                courseId: input.courseId,
                userId: { in: parsed.userIds },
            },
            select: { userId: true },
        })
        const existingSet = new Set(existing.map((row) => row.userId))
        const toCreate = parsed.userIds.filter((id) => !existingSet.has(id))

        if (toCreate.length > 0) {
            await prisma.$transaction(async (tx) => {
                await tx.enrollment.createMany({
                    data: toCreate.map((userId) => ({
                        courseId: input.courseId,
                        userId,
                        status: 'ACTIVE',
                        progress: 0,
                    })),
                    skipDuplicates: true,
                })

                await tx.course.update({
                    where: { id: input.courseId },
                    data: {
                        enrolledCount: {
                            increment: toCreate.length,
                        },
                    },
                })
            })
        }

        const notificationResults = { sent: 0, failed: 0 }
        if (parsed.sendNotification && toCreate.length > 0) {
            for (const userId of toCreate) {
                const result = await WecomWebhookService.sendCourseInvitation(userId, input.courseId)
                if (result.success) notificationResults.sent++
                else notificationResults.failed++
            }
        }

        return {
            success: true,
            tool: 'assign_course_invitations',
            summary: `Assigned ${toCreate.length} learners to "${course.title}".`,
            data: {
                course: {
                    id: course.id,
                    title: course.title,
                    status: course.status,
                },
                invitationsCreated: toCreate.length,
                invitationsSkipped: parsed.userIds.length - toCreate.length,
                notificationsSent: notificationResults.sent,
                notificationsFailed: notificationResults.failed,
            },
            nextActions: course.learningEventId ? ['review_event_status', 'list_my_workspace'] : ['list_my_workspace'],
            recommendedNextInputs: course.learningEventId
                ? {
                    review_event_status: {
                        event: course.learningEventId,
                    },
                }
                : {
                    list_my_workspace: {},
                },
        }
    }

    static async publishExamForLearners(
        user: MappableUser,
        input: {
            exam: string
            userIds?: string[]
            sendNotification?: boolean
        }
    ): Promise<ToolResult<{
        exam: {
            id: string
            title: string
            status: ExamStatus
            publishedAt: Date | null
            invitationCount: number
        }
        invitationsCreated: number
        invitationsSkipped: number
        notificationsSent: number
        notificationsFailed: number
    }>> {
        const exam = await this.resolveExamReference(user, input.exam)
        const result = await this.publishExamWithInvitations(user, {
            examId: exam.id,
            userIds: input.userIds ?? [],
            sendNotification: input.sendNotification,
        })

        return {
            ...result,
            tool: 'publish_exam_for_learners',
            summary:
                result.data.invitationsCreated > 0
                    ? `Published exam "${result.data.exam.title}" for learners and created ${result.data.invitationsCreated} invitations.`
                    : `Published exam "${result.data.exam.title}" for learners.`,
        }
    }

    static async shareCourseWithLearners(
        user: MappableUser,
        input: {
            course: string
            userIds: string[]
            sendNotification?: boolean
        }
    ): Promise<ToolResult<{
        course: {
            id: string
            title: string
            status: string
        }
        invitationsCreated: number
        invitationsSkipped: number
        notificationsSent: number
        notificationsFailed: number
    }>> {
        const course = await this.resolveCourseReference(user, input.course)
        const result = await this.assignCourseInvitations(user, {
            courseId: course.id,
            userIds: input.userIds,
            sendNotification: input.sendNotification,
        })

        return {
            ...result,
            tool: 'share_course_with_learners',
            summary:
                result.data.invitationsCreated > 0
                    ? `Shared course "${result.data.course.title}" with ${result.data.invitationsCreated} learners.`
                    : `No new learner assignments were needed for course "${result.data.course.title}".`,
        }
    }

    private static async prepareTranscriptUploadInternal(
        user: MappableUser,
        input: {
            lessonId: string
            videoAssetId?: string
            filename: string
            contentType?: 'text/vtt'
            languageCode?: string
            label?: string | null
            replaceExistingLanguage?: boolean
            setAsDefaultSubtitle?: boolean
            setAsPrimaryForAI?: boolean
        },
        toolName: 'prepare_transcript_upload' | 'upload_transcript_and_process'
    ): Promise<ToolResult<Record<string, unknown>>> {
        await TrainingOpsService.assertScopedLessonAccess(user, input.lessonId)

        const filename = input.filename
        const lesson = await prisma.lesson.findUnique({
            where: { id: input.lessonId },
            include: {
                chapter: { select: { courseId: true } },
            },
        })

        if (!lesson) {
            throw new Error('LESSON_NOT_FOUND')
        }

        const lessonVideoAssetBindings = await prisma.lessonAsset.findMany({
            where: {
                lessonId: input.lessonId,
                courseAsset: {
                    type: 'VIDEO',
                },
            },
            select: {
                courseAsset: {
                    select: {
                        id: true,
                        title: true,
                        mimeType: true,
                        contentType: true,
                    },
                },
            },
        })
        const videoAssets = lessonVideoAssetBindings.map((binding) => binding.courseAsset)

        if (videoAssets.length === 0) {
            throw new Error('VIDEO_ASSET_NOT_FOUND')
        }

        let resolvedVideoAssetId = input.videoAssetId

        if (!resolvedVideoAssetId && videoAssets.length === 1) {
            resolvedVideoAssetId = videoAssets[0].id
        }

        if (!resolvedVideoAssetId) {
            throw errorWithDetails('VIDEO_ASSET_SELECTION_REQUIRED', {
                lessonId: input.lessonId,
                candidateVideoAssets: videoAssets.map((asset) => ({
                    id: asset.id,
                    title: asset.title,
                    mimeType: asset.mimeType ?? asset.contentType ?? null,
                })),
            })
        }

        const videoAsset = videoAssets.find((asset) => asset.id === resolvedVideoAssetId)

        if (!videoAsset) {
            throw errorWithDetails('VIDEO_ASSET_NOT_IN_LESSON', {
                lessonId: input.lessonId,
                videoAssetId: resolvedVideoAssetId,
                candidateVideoAssets: videoAssets.map((asset) => ({
                    id: asset.id,
                    title: asset.title,
                    mimeType: asset.mimeType ?? asset.contentType ?? null,
                })),
            })
        }

        const transcriptId = uuidv4()
        const inferredLanguage = inferTranscriptLanguageFromFilename(filename)
        const language = inferredLanguage ?? normalizeTranscriptLanguage(input.languageCode ?? 'en')
        const label = input.label?.trim() || null
        const key = [S3_ASSET_BASE_PREFIX, lesson.chapter.courseId, input.lessonId, `${transcriptId}.vtt`]
            .filter(Boolean)
            .map((segment) => String(segment).replace(/^\/+|\/+$/g, ''))
            .join('/')

        const activeTracks = await prisma.transcriptAsset.findMany({
            where: {
                lessonId: input.lessonId,
                isActive: true,
                archivedAt: null,
            },
        })
        const replaceExistingLanguage = input.replaceExistingLanguage ?? true
        const remainingActiveTracks = replaceExistingLanguage
            ? activeTracks.filter(
                (track) => !(track.videoAssetId === resolvedVideoAssetId && track.language === language)
            )
            : activeTracks

        const hasDefaultForVideo = remainingActiveTracks.some(
            (track) => track.videoAssetId === resolvedVideoAssetId && track.isDefaultSubtitle
        )
        const hasPrimaryForLesson = remainingActiveTracks.some((track) => track.isPrimaryForAI)
        const shouldSetDefault = input.setAsDefaultSubtitle ?? !hasDefaultForVideo
        const shouldSetPrimary = input.setAsPrimaryForAI ?? !hasPrimaryForLesson

        const uploadData = await FileService.generateTranscriptUploadUrl({
            filename: input.filename,
            lessonId: input.lessonId,
            key,
        })

        await prisma.$transaction(async (tx) => {
            if (replaceExistingLanguage) {
                await tx.transcriptAsset.updateMany({
                    where: {
                        lessonId: input.lessonId,
                        videoAssetId: resolvedVideoAssetId,
                        language,
                        isActive: true,
                        archivedAt: null,
                    },
                    data: {
                        isActive: false,
                        isDefaultSubtitle: false,
                        isPrimaryForAI: false,
                        archivedAt: new Date(),
                    },
                })
            }

            if (shouldSetDefault) {
                await tx.transcriptAsset.updateMany({
                    where: {
                        videoAssetId: resolvedVideoAssetId,
                        isActive: true,
                        archivedAt: null,
                        isDefaultSubtitle: true,
                    },
                    data: {
                        isDefaultSubtitle: false,
                    },
                })
            }

            if (shouldSetPrimary) {
                await tx.transcriptAsset.updateMany({
                    where: {
                        lessonId: input.lessonId,
                        isActive: true,
                        archivedAt: null,
                        isPrimaryForAI: true,
                    },
                    data: {
                        isPrimaryForAI: false,
                    },
                })
            }

            await tx.transcriptAsset.create({
                data: {
                    id: transcriptId,
                    lessonId: input.lessonId,
                    videoAssetId: resolvedVideoAssetId,
                    filename,
                    s3Key: uploadData.key,
                    url: null,
                    language,
                    label,
                    isDefaultSubtitle: shouldSetDefault,
                    isPrimaryForAI: shouldSetPrimary,
                    isActive: true,
                    status: 'PENDING',
                    sourceType: 'MANUAL',
                },
            })
        })

        return {
            success: true,
            tool: toolName,
            summary: `Prepared transcript upload for lesson "${input.lessonId}".`,
            data: {
                phase: 'upload',
                lessonId: input.lessonId,
                transcriptAsset: {
                    id: transcriptId,
                    lessonId: input.lessonId,
                    videoAssetId: resolvedVideoAssetId,
                    status: 'PENDING',
                    filename: input.filename,
                    language,
                    label: label ?? getTranscriptLabel({ language, label }),
                    isDefaultSubtitle: shouldSetDefault,
                    isPrimaryForAI: shouldSetPrimary,
                },
                uploadUrl: uploadData.uploadUrl,
                s3Key: uploadData.key,
                expiresIn: uploadData.expiresIn,
                requiredHeaders: {
                    'Content-Type': 'text/vtt',
                    'x-amz-server-side-encryption': 'AES256',
                },
            },
            nextActions: ['process_transcript_knowledge', 'review_event_status'],
            recommendedNextInputs: {
                process_transcript_knowledge: {
                    lessonId: input.lessonId,
                    transcriptId,
                    processTranscript: true,
                    processKnowledge: true,
                },
            },
        }
    }

    private static async processTranscriptKnowledgeInternal(
        user: MappableUser,
        input: {
            lessonId: string
            transcriptId?: string
            processTranscript?: boolean
            processKnowledge?: boolean
            force?: boolean
            knowledgePromptTemplateId?: string | null
        },
        toolName: 'process_transcript_knowledge' | 'upload_transcript_and_process'
    ): Promise<ToolResult<Record<string, unknown>>> {
        await TrainingOpsService.assertScopedLessonAccess(user, input.lessonId)

        if (!input.processTranscript && !input.processKnowledge) {
            throw new Error('NO_PROCESSING_ACTIONS')
        }

        const lesson = await prisma.lesson.findUnique({
            where: { id: input.lessonId },
            include: {
                transcripts: {
                    where: {
                        isActive: true,
                        archivedAt: null,
                    },
                    orderBy: [{ isPrimaryForAI: 'desc' }, { isDefaultSubtitle: 'desc' }, { createdAt: 'asc' }],
                },
            },
        })

        if (!lesson) {
            throw new Error('LESSON_NOT_FOUND')
        }

        const requestedTranscript = lesson.transcripts.find((track) => track.id === input.transcriptId) ?? null
        const transcript = requestedTranscript ?? getPrimaryAiTranscriptTrack(lesson.transcripts)

        if (!transcript) {
            throw new Error('TRANSCRIPT_TRACK_NOT_FOUND')
        }

        const force = Boolean(input.force)
        if (input.knowledgePromptTemplateId) {
            const template = await prisma.aIPromptTemplate.findUnique({
                where: { id: input.knowledgePromptTemplateId },
                select: {
                    id: true,
                    isActive: true,
                    useCase: true,
                },
            })

            if (!template || !template.isActive) {
                throw new Error('PROMPT_TEMPLATE_NOT_FOUND')
            }

            if (template.useCase !== KNOWLEDGE_CONTEXT_OVERRIDE_USE_CASE) {
                throw new Error('PROMPT_TEMPLATE_USE_CASE_MISMATCH')
            }
        }

        const result: Record<string, unknown> = {
            phase: 'process',
            lessonId: input.lessonId,
            transcriptId: transcript.id,
            effectiveActions: {
                processTranscript: Boolean(input.processTranscript),
                processKnowledge: Boolean(input.processKnowledge),
                force,
            },
        }

        if (input.processTranscript) {
            const transcriptJobService = new TranscriptJobService(prisma)
            const activeTranscriptJob = await transcriptJobService.getActiveJobForTranscript(transcript.id)
            if (activeTranscriptJob && !force) {
                throw new Error('TRANSCRIPT_PROCESS_CONFLICT')
            }
            if (force) {
                await transcriptJobService.cancelActiveJobs(transcript.id)
            }

            const transcriptJob = await transcriptJobService.enqueueJob({
                transcriptId: transcript.id,
                lessonId: input.lessonId,
            })

            await transcriptJobService.appendEvent({
                jobId: transcriptJob.id,
                level: 'info',
                stage: 'PENDING',
                message: 'Job enqueued from SME MCP',
                data: {
                    lessonId: input.lessonId,
                    transcriptId: transcript.id,
                    s3Key: transcript.s3Key,
                    force,
                },
            })

            await prisma.transcriptAsset.update({
                where: { id: transcript.id },
                data: {
                    status: 'PENDING',
                    errorMessage: null,
                    processedAt: null,
                },
            })

            result.transcriptProcessing = {
                jobId: transcriptJob.id,
                status: 'PENDING',
            }
        }

        if (input.processKnowledge) {
            const knowledgeJobService = new KnowledgeContextJobService(prisma)
            const activeKnowledgeJob = await knowledgeJobService.getActiveJobForLesson(input.lessonId)
            if (activeKnowledgeJob && !force) {
                throw new Error('KNOWLEDGE_PROCESS_CONFLICT')
            }
            if (force) {
                await knowledgeJobService.cancelActiveJobs(input.lessonId)
            }

            const knowledgeJob = await knowledgeJobService.enqueueJob({
                lessonId: input.lessonId,
                transcriptId: transcript.id,
                metrics: {
                    transcriptS3Key: transcript.s3Key,
                    promptTemplateId: input.knowledgePromptTemplateId ?? null,
                },
            })

            await knowledgeJobService.appendEvent({
                jobId: knowledgeJob.id,
                level: 'info',
                stage: 'PENDING',
                message: 'Knowledge context job enqueued from SME MCP',
                data: {
                    lessonId: input.lessonId,
                    transcriptId: transcript.id,
                    transcriptS3Key: transcript.s3Key,
                    force,
                    promptTemplateId: input.knowledgePromptTemplateId ?? null,
                },
            })

            result.knowledgeProcessing = {
                jobId: knowledgeJob.id,
                status: 'QUEUED',
            }
        }

        return {
            success: true,
            tool: toolName,
            summary: `Queued transcript/knowledge processing for lesson "${input.lessonId}".`,
            data: result,
            nextActions: ['review_event_status'],
        }
    }

    static async prepareTranscriptUpload(
        user: MappableUser,
        input: {
            lessonId: string
            videoAssetId?: string
            filename: string
            contentType?: 'text/vtt'
            languageCode?: string
            label?: string | null
            replaceExistingLanguage?: boolean
            setAsDefaultSubtitle?: boolean
            setAsPrimaryForAI?: boolean
        }
    ): Promise<ToolResult<Record<string, unknown>>> {
        return this.prepareTranscriptUploadInternal(user, input, 'prepare_transcript_upload')
    }

    static async processTranscriptKnowledge(
        user: MappableUser,
        input: {
            lessonId: string
            transcriptId?: string
            processTranscript?: boolean
            processKnowledge?: boolean
            force?: boolean
            knowledgePromptTemplateId?: string | null
        }
    ): Promise<ToolResult<Record<string, unknown>>> {
        const processTranscript = input.processTranscript ?? (input.processKnowledge === undefined)
        const processKnowledge = input.processKnowledge ?? (input.processTranscript === undefined)

        return this.processTranscriptKnowledgeInternal(
            user,
            {
                ...input,
                processTranscript,
                processKnowledge,
            },
            'process_transcript_knowledge'
        )
    }

}
