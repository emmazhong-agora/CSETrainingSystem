import { AuthUser } from './auth-middleware'
import type {
    Course,
    CourseLevel,
    LessonProgress,
    AdminUser,
    AdminUserStats,
    AdminSmeScopeAudit,
    AdminAnalyticsSummary,
    TrainingOpsBridge,
    TrainingOpsAdminReport,
    TrainingOpsReportRange,
    SmeWorkspaceSummary,
    ProductDomainEffectivenessSummary,
    ProductDomainEffectivenessAttempt,
    ProductDomainSummary,
    BadgeMilestoneSummary,
    TrainingOpsBadgeImportSummary,
    TrainingOpsLearningSeriesImportSummary,
    TrainingOpsDomainImportSummary,
    TrainingOpsBootstrapImportSummary,
    SmeBadgeLadderOverview,
    SmeManagedExamDetail,
    SmeManagedCourseDetail,
    LearningSeriesSummary,
    LearningEventSummary,
    TrainingOpsExamSummary,
    TrainingOpsCourseSummary,
    LearnerRewardsOverview,
    LearnerTrainingOverview,
    UserProgressOverview,
    UserProfile,
    UpdateProfilePayload,
    McpAccessTokenSummary,
    CreateMcpAccessTokenPayload,
    Exam,
    ExamQuestion,
    ExamAttempt,
    ExamInvitation,
    CourseInvitation,
    ExamAnalytics,
    ExamStatus,
    ExamQuestionType,
    EssayAIGradingBreakdown,
    EssayGradingCriterion,
    CourseDownloadsPayload,
} from '@/types'

// Types
export interface LoginResponse {
    success: boolean
    data: {
        user: AuthUser
        session: {
            accessToken: string
            refreshToken: string
            expiresIn: number
        }
    }
    message?: string
}

export interface RegisterPayload {
    email: string
    password: string
    name: string
    department?: string
}

export type RegisterResponse = LoginResponse

export interface AdminCreateUserPayload {
    email: string
    password: string
    name: string
    wecomUserId: string
    department?: string
    title?: string
}

export interface ApiError {
    success: false
    error: {
        code: string
        message: string
    }
}

const BASE_URL = '/api'

type CourseStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED'

type CreateCoursePayload = {
    title: string
    slug: string
    description: string
    thumbnail?: string
    level: CourseLevel
    category: string
    tags: string[]
    instructorId: string
    learningEventId?: string | null
    status?: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED'
}

type UpdateCoursePayload = Partial<CreateCoursePayload> & {
    status?: CourseStatus
    sendNotification?: boolean
}

export class ApiClient {
    private static getToken(): string | null {
        if (typeof window !== 'undefined') {
            return localStorage.getItem('accessToken')
        }
        return null
    }

    private static setToken(token: string) {
        if (typeof window !== 'undefined') {
            localStorage.setItem('accessToken', token)
        }
    }

    static logout() {
        if (typeof window !== 'undefined') {
            localStorage.removeItem('accessToken')
            window.location.href = '/login'
        }
    }

    public static async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
        const token = this.getToken()

        const { headers: requestHeaders, ...restOptions } = options
        const headers = new Headers(requestHeaders ?? {})

        if (!headers.has('Content-Type')) {
            headers.set('Content-Type', 'application/json')
        }

        if (token) {
            headers.set('Authorization', `Bearer ${token}`)
        }

        const response = await fetch(`${BASE_URL}${endpoint}`, {
            ...restOptions,
            headers,
        })

        const data = await response.json()

        if (!response.ok) {
            if (response.status === 401) {
                // Token expired or invalid
                this.logout()
            }

            const detailMessage = Array.isArray(data?.error?.details) && data.error.details.length > 0
                ? data.error.details[0]?.message
                : undefined

            const baseMessage = data?.error?.message || 'API request failed'
            const message = detailMessage ? `${baseMessage} (${detailMessage})` : baseMessage

            throw new Error(message)
        }

        return data
    }

    // Auth
    static async login(email: string, password: string): Promise<LoginResponse> {
        const response = await this.request<LoginResponse>('/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email, password }),
        })

        if (response.success && response.data.session) {
            this.setToken(response.data.session.accessToken)
        }

        return response
    }

    static async register(payload: RegisterPayload): Promise<RegisterResponse> {
        const response = await this.request<RegisterResponse>('/auth/register', {
            method: 'POST',
            body: JSON.stringify(payload),
        })

        if (response.success && response.data.session) {
            this.setToken(response.data.session.accessToken)
        }

        return response
    }

    static async getMe(): Promise<{ success: boolean; data: AuthUser }> {
        return this.request('/auth/me')
    }

    static async callSmeMcp<T = unknown>(tool: string, input: Record<string, unknown> = {}): Promise<{
        success: boolean
        summary?: string
        data?: T
        nextActions?: string[]
        recommendedNextInputs?: Record<string, unknown>
        warnings?: string[]
    }> {
        return this.request('/sme/mcp', {
            method: 'POST',
            body: JSON.stringify({ tool, input }),
        })
    }

    static async getAiPromptTemplates(params: Record<string, string | number | boolean | undefined> = {}): Promise<{
        success: boolean
        data: Array<{
            id: string
            name: string
            slug: string
            useCase: string
            isActive: boolean
        }>
    }> {
        const query = new URLSearchParams()
        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== null && value !== '') {
                query.set(key, String(value))
            }
        })
        const search = query.toString() ? `?${query.toString()}` : ''
        return this.request(`/admin/ai/prompt-templates${search}`)
    }

    static async getProfile(): Promise<{ success: boolean; data: UserProfile }> {
        return this.request('/profile')
    }

    static async updateProfile(payload: UpdateProfilePayload): Promise<{
        success: boolean
        data: UserProfile
    }> {
        return this.request('/profile', {
            method: 'PUT',
            body: JSON.stringify(payload),
        })
    }

    static async changePassword(payload: { currentPassword?: string; newPassword: string }): Promise<{ success: boolean }> {
        return this.request('/profile/password', {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    static async getMcpAccessTokens(): Promise<{ success: boolean; data: McpAccessTokenSummary[] }> {
        return this.request('/mcp-access-tokens')
    }

    static async createMcpAccessToken(payload: CreateMcpAccessTokenPayload): Promise<{
        success: boolean
        data: {
            token: string
            record: McpAccessTokenSummary
        }
    }> {
        return this.request('/mcp-access-tokens', {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    static async revokeMcpAccessToken(tokenId: string): Promise<{ success: boolean; data: McpAccessTokenSummary }> {
        return this.request(`/mcp-access-tokens/${tokenId}/revoke`, {
            method: 'POST',
        })
    }

    // Courses (public)
    static async getCourses(params: Record<string, string | number | undefined> = {}): Promise<{
        success: boolean
        data: {
            courses: Course[]
            pagination: {
                page: number
                limit: number
                total: number
                totalPages: number
            }
        }
    }> {
        const query = new URLSearchParams()
        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== null) {
                query.set(key, String(value))
            }
        })

        const search = query.toString() ? `?${query.toString()}` : ''
        return this.request(`/courses${search}`)
    }

    // Admin Courses (ALL statuses by default)
    static async getAdminCourses(params: Record<string, string | number | undefined> = {}): Promise<{
        success: boolean
        data: Course[]
        pagination: {
            page: number
            limit: number
            total: number
            totalPages: number
        }
    }> {
        const query = new URLSearchParams()
        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== null) {
                query.set(key, String(value))
            }
        })
        const search = query.toString() ? `?${query.toString()}` : ''
        return this.request(`/admin/courses${search}`)
    }

    static async getAdminCourseAnalytics(courseId: string): Promise<{
        success: boolean
        data: {
            courseId: string
            enrolledUsers: Array<{
                user: {
                    id: string
                    name: string
                    email: string
                    avatar?: string | null
                    department?: string | null
                    title?: string | null
                }
                status: 'ACTIVE' | 'COMPLETED' | 'DROPPED'
                progress: number
                enrolledAt: string | Date
                lastAccessedAt?: string | Date | null
                completedAt?: string | Date | null
            }>
            activeLearners: { d7: number; d14: number; d30: number }
            completionRate: number
            averageCompletionTimeSeconds: number | null
        }
    }> {
        return this.request(`/admin/courses/${courseId}/analytics`)
    }

    static async getCourse(id: string): Promise<{ success: boolean; data: Course & { isEnrolled: boolean; progress: number; aiAssistantEnabled?: boolean } }> {
        return this.request(`/courses/${id}`)
    }

    static async getCourseContent(id: string) {
        return this.request(`/courses/${id}/content`)
    }

    static async getCourseDownloads(id: string): Promise<{ success: boolean; data: CourseDownloadsPayload }> {
        return this.request(`/courses/${id}/downloads`)
    }

    static async enrollInCourse(courseId: string) {
        return this.request(`/courses/${courseId}/enroll`, {
            method: 'POST',
        })
    }

    // Admin Courses
    static async createCourse(payload: CreateCoursePayload) {
        return this.request('/admin/courses', {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    static async updateCourse(courseId: string, payload: UpdateCoursePayload) {
        return this.request(`/admin/courses/${courseId}`, {
            method: 'PUT',
            body: JSON.stringify(payload),
        })
    }

    static async deleteCourse(courseId: string) {
        return this.request(`/admin/courses/${courseId}`, {
            method: 'DELETE',
        })
    }

    // Course structure (Step 2)
    static async createChapter(courseId: string, payload: { title: string; description?: string; order?: number }) {
        return this.request(`/admin/courses/${courseId}/chapters`, {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    static async updateChapter(courseId: string, chapterId: string, payload: Partial<{ title: string; description?: string; order?: number }>) {
        return this.request(`/admin/courses/${courseId}/chapters/${chapterId}`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
        })
    }

    static async deleteChapter(courseId: string, chapterId: string) {
        return this.request(`/admin/courses/${courseId}/chapters/${chapterId}`, { method: 'DELETE' })
    }

    static async reorderChapters(courseId: string, chapterOrder: string[]) {
        return this.request(`/admin/courses/${courseId}/chapters/reorder`, {
            method: 'PATCH',
            body: JSON.stringify({ chapterOrder }),
        })
    }

    static async createLesson(courseId: string, chapterId: string, payload: {
        title: string
        description?: string
        durationMinutes?: number
        lessonType?: 'VIDEO' | 'DOC' | 'QUIZ' | 'OTHER'
        learningObjectives?: string[]
        completionRule?: 'VIEW_ASSETS' | 'MANUAL' | 'QUIZ'
        order?: number
    }) {
        return this.request(`/admin/courses/${courseId}/chapters/${chapterId}/lessons`, {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    static async updateLesson(courseId: string, chapterId: string, lessonId: string, payload: Partial<{
        title: string
        description?: string
        durationMinutes?: number
        lessonType?: 'VIDEO' | 'DOC' | 'QUIZ' | 'OTHER'
        learningObjectives?: string[]
        completionRule?: 'VIEW_ASSETS' | 'MANUAL' | 'QUIZ'
        order?: number
    }>) {
        return this.request(`/admin/courses/${courseId}/chapters/${chapterId}/lessons/${lessonId}`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
        })
    }

    static async deleteLesson(courseId: string, chapterId: string, lessonId: string) {
        return this.request(`/admin/courses/${courseId}/chapters/${chapterId}/lessons/${lessonId}`, { method: 'DELETE' })
    }

    static async reorderLessons(courseId: string, chapterId: string, lessonOrder: string[]) {
        return this.request(`/admin/courses/${courseId}/chapters/${chapterId}/lessons/reorder`, {
            method: 'PATCH',
            body: JSON.stringify({ lessonOrder }),
        })
    }

    static async replaceLessonAssets(courseId: string, chapterId: string, lessonId: string, courseAssetIds: string[]) {
        return this.request(`/admin/courses/${courseId}/chapters/${chapterId}/lessons/${lessonId}/assets`, {
            method: 'POST',
            body: JSON.stringify({ courseAssetIds }),
        })
    }

    static async uploadLessonAsset(courseId: string, chapterId: string, lessonId: string, payload: { filename: string; contentType: string; type: 'VIDEO' | 'DOCUMENT' | 'PRESENTATION' | 'TEXT' | 'AUDIO' | 'WEB_PACKAGE' | 'OTHER' }): Promise<{
        success: boolean
        data: {
            uploadSessionId: string
            courseAssetId: string
            status: 'PENDING_UPLOAD'
            uploadUrl: string
            key: string
            url: string
            mimeType: string
            expiresIn: number
            requiredHeaders: Record<string, string>
        }
    }> {
        return this.request(`/admin/courses/${courseId}/chapters/${chapterId}/lessons/${lessonId}/assets/upload`, {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    static async confirmLessonAssetUpload(courseId: string, chapterId: string, lessonId: string, payload: {
        uploadSessionId: string
    }): Promise<{
        success: boolean
        data: {
            uploadSessionId: string
            status: 'CONFIRMED'
            asset: {
                id: string
                title: string
                type: 'VIDEO' | 'DOCUMENT' | 'PRESENTATION' | 'TEXT' | 'AUDIO' | 'WEB_PACKAGE' | 'OTHER'
                url: string
                mimeType?: string
                s3Key: string
            }
        }
    }> {
        return this.request(`/admin/courses/${courseId}/chapters/${chapterId}/lessons/${lessonId}/assets/confirm`, {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    static async uploadLessonWebPackage(courseId: string, chapterId: string, lessonId: string, payload: {
        title: string
        files: Array<{ path: string; contentType: string }>
    }): Promise<{
        success: boolean
        data: {
            uploadSessionId: string
            courseAssetId: string
            status: 'PENDING_UPLOAD'
            uploads: Array<{
                path: string
                key: string
                uploadUrl: string
                requiredHeaders: Record<string, string>
            }>
            expiresAt: string | Date
        }
    }> {
        return this.request(`/admin/courses/${courseId}/chapters/${chapterId}/lessons/${lessonId}/assets/web-package/upload`, {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    static async confirmLessonWebPackage(courseId: string, chapterId: string, lessonId: string, payload: {
        uploadSessionId: string
    }): Promise<{
        success: boolean
        data: {
            uploadSessionId: string
            status: 'CONFIRMED'
            asset: {
                id: string
                title: string
                type: 'WEB_PACKAGE'
                url: string
                mimeType?: string
                s3Key: string
            }
        }
    }> {
        return this.request(`/admin/courses/${courseId}/chapters/${chapterId}/lessons/${lessonId}/assets/web-package/confirm`, {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    static async abortLessonAssetUpload(courseId: string, chapterId: string, lessonId: string, payload: {
        uploadSessionId: string
        reason?: string | null
    }): Promise<{ success: boolean; data: { id: string; status: 'ABORTED' } }> {
        return this.request(`/admin/courses/${courseId}/chapters/${chapterId}/lessons/${lessonId}/assets/abort`, {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    static async deleteLessonAsset(courseId: string, chapterId: string, lessonId: string, courseAssetId: string) {
        return this.request(`/admin/courses/${courseId}/chapters/${chapterId}/lessons/${lessonId}/assets/${courseAssetId}`, { method: 'DELETE' })
    }

    static async getInstructors(): Promise<{ success: boolean; data: Array<{ id: string; name: string; email: string; title?: string }> }> {
        return this.request('/admin/instructors')
    }

    static async getUsers(params: Record<string, string | number | undefined> = {}): Promise<{
        success: boolean
        data: {
            users: AdminUser[]
            stats: AdminUserStats
            pagination: {
                page: number
                limit: number
                total: number
                totalPages: number
            }
        }
    }> {
        const query = new URLSearchParams()
        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== null && value !== '') {
                query.set(key, String(value))
            }
        })

        const search = query.toString() ? `?${query.toString()}` : ''
        return this.request(`/admin/users${search}`)
    }

    static async updateUser(
        userId: string,
        payload: {
            role?: 'USER' | 'SME' | 'ADMIN'
            status?: 'ACTIVE' | 'SUSPENDED' | 'DELETED'
            name?: string
            email?: string
            wecomUserId?: string
            department?: string | null
            title?: string | null
            domainIds?: string[]
        }
    ) {
        return this.request(`/admin/users/${userId}`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
        })
    }

    static async createAdminUser(payload: AdminCreateUserPayload): Promise<{
        success: boolean
        data: AdminUser
    }> {
        return this.request('/admin/users', {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    static async resetUserPassword(userId: string, payload: { newPassword: string }): Promise<{ success: boolean }> {
        return this.request(`/admin/users/${userId}/password`, {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    static async promoteUserToSme(userId: string, payload: {
        domainIds: string[]
    }): Promise<{
        success: boolean
        data: {
            user: AdminUser
            assignments: Array<{
                domainId: string
                domainName: string
                slot: 'PRIMARY' | 'BACKUP' | null
            }>
        }
    }> {
        return this.request(`/admin/users/${userId}/promote-sme`, {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    static async getSmeScopeAudit(): Promise<{
        success: boolean
        data: AdminSmeScopeAudit
    }> {
        return this.request('/admin/users/sme-scope-audit')
    }

    static async getAnalytics(params: Record<string, string | number | undefined> = {}): Promise<{
        success: boolean
        data: AdminAnalyticsSummary
    }> {
        const query = new URLSearchParams()
        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== null && value !== '') {
                query.set(key, String(value))
            }
        })

        const search = query.toString() ? `?${query.toString()}` : ''
        return this.request(`/admin/analytics${search}`)
    }

    static async getTrainingOpsBridge(): Promise<{
        success: boolean
        data: TrainingOpsBridge
    }> {
        return this.request('/admin/training-ops/bridge')
    }

    static async getTrainingOpsAdminReport(params?: {
        range?: TrainingOpsReportRange
        includeAdmins?: boolean
        excludeUserIds?: string[]
    }): Promise<{
        success: boolean
        data: TrainingOpsAdminReport
    }> {
        const query = new URLSearchParams()
        if (params?.range) {
            query.set('range', params.range)
        }
        if (typeof params?.includeAdmins === 'boolean') {
            query.set('includeAdmins', String(params.includeAdmins))
        }
        if (params?.excludeUserIds?.length) {
            query.set('excludeUserIds', params.excludeUserIds.join(','))
        }
        const search = query.toString() ? `?${query.toString()}` : ''
        return this.request(`/admin/training-ops/report${search}`)
    }

    static async getTrainingOpsDomains(params: Record<string, string | number | boolean | undefined> = {}): Promise<{
        success: boolean
        data: ProductDomainSummary[]
        pagination: {
            page: number
            limit: number
            total: number
            totalPages: number
        }
    }> {
        const query = new URLSearchParams()
        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== null && value !== '') {
                query.set(key, String(value))
            }
        })
        const search = query.toString() ? `?${query.toString()}` : ''
        return this.request(`/admin/training-ops/domains${search}`)
    }

    static async getTrainingOpsEffectiveness(): Promise<{
        success: boolean
        data: ProductDomainEffectivenessSummary[]
    }> {
        return this.request('/admin/training-ops/effectiveness')
    }

    static async getTrainingOpsEffectivenessAttempts(
        domainId: string,
        params: Record<string, string | number | undefined> = {}
    ): Promise<{
        success: boolean
        data: {
            domain: { id: string; name: string }
            attempts: ProductDomainEffectivenessAttempt[]
        }
        pagination: {
            page: number
            limit: number
            total: number
            totalPages: number
        }
    }> {
        const query = new URLSearchParams()
        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== null && value !== '') {
                query.set(key, String(value))
            }
        })
        const search = query.toString() ? `?${query.toString()}` : ''
        return this.request(`/admin/training-ops/effectiveness/${domainId}/attempts${search}`)
    }

    static async getTrainingOpsDomain(id: string): Promise<{
        success: boolean
        data: ProductDomainSummary
    }> {
        return this.request(`/admin/training-ops/domains/${id}`)
    }

    static async createTrainingOpsDomain(payload: {
        name: string
        slug: string
        category: ProductDomainSummary['category']
        track: ProductDomainSummary['track']
        kpiMode: ProductDomainSummary['kpiMode']
        description?: string | null
        cadence?: string | null
        active: boolean
        baselinePassRate?: number | null
        targetPassRate?: number | null
        challengeThreshold?: number | null
        primarySmeId?: string | null
        backupSmeId?: string | null
    }): Promise<{
        success: boolean
        data: ProductDomainSummary
    }> {
        return this.request('/admin/training-ops/domains', {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    static async updateTrainingOpsDomain(id: string, payload: {
        name?: string
        slug?: string
        category?: ProductDomainSummary['category']
        track?: ProductDomainSummary['track']
        kpiMode?: ProductDomainSummary['kpiMode']
        description?: string | null
        cadence?: string | null
        active?: boolean
        baselinePassRate?: number | null
        targetPassRate?: number | null
        challengeThreshold?: number | null
        primarySmeId?: string | null
        backupSmeId?: string | null
    }): Promise<{
        success: boolean
        data: ProductDomainSummary
    }> {
        return this.request(`/admin/training-ops/domains/${id}`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
        })
    }

    static async importTrainingOpsDomains(payload: {
        payload: unknown
        apply?: boolean
    }): Promise<{
        success: boolean
        data: TrainingOpsDomainImportSummary
    }> {
        return this.request('/admin/training-ops/domains/import', {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    static async importTrainingOpsBootstrap(payload: {
        payload: unknown
        apply?: boolean
    }): Promise<{
        success: boolean
        data: TrainingOpsBootstrapImportSummary
    }> {
        return this.request('/admin/training-ops/import', {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    static async getTrainingOpsSeries(params: Record<string, string | number | boolean | undefined> = {}): Promise<{
        success: boolean
        data: LearningSeriesSummary[]
        pagination: {
            page: number
            limit: number
            total: number
            totalPages: number
        }
    }> {
        const query = new URLSearchParams()
        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== null && value !== '') {
                query.set(key, String(value))
            }
        })
        const search = query.toString() ? `?${query.toString()}` : ''
        return this.request(`/admin/training-ops/series${search}`)
    }

    static async getTrainingOpsSeriesById(id: string): Promise<{
        success: boolean
        data: LearningSeriesSummary
    }> {
        return this.request(`/admin/training-ops/series/${id}`)
    }

    static async createTrainingOpsSeries(payload: {
        name: string
        slug: string
        type: LearningSeriesSummary['type']
        domainId?: string | null
        description?: string | null
        cadence?: string | null
        isActive: boolean
        countsTowardPerformance?: boolean
        defaultStarValue?: number | null
        ownerId?: string | null
    }): Promise<{
        success: boolean
        data: LearningSeriesSummary
    }> {
        return this.request('/admin/training-ops/series', {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    static async updateTrainingOpsSeries(id: string, payload: {
        name?: string
        slug?: string
        type?: LearningSeriesSummary['type']
        domainId?: string | null
        description?: string | null
        cadence?: string | null
        isActive?: boolean
        countsTowardPerformance?: boolean
        defaultStarValue?: number | null
        ownerId?: string | null
    }): Promise<{
        success: boolean
        data: LearningSeriesSummary
    }> {
        return this.request(`/admin/training-ops/series/${id}`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
        })
    }

    static async associateTrainingOpsProgramResource(programId: string, payload: {
        resourceType: 'event' | 'course' | 'exam'
        resourceId: string
        eventId?: string
    }): Promise<{
        success: boolean
        data: {
            programId: string
            resourceType: 'event' | 'course' | 'exam'
            resourceId: string
        }
    }> {
        return this.request(`/training-ops/programs/${programId}/associations`, {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    static async importTrainingOpsLearningSeries(payload: {
        payload: unknown
        apply?: boolean
    }): Promise<{
        success: boolean
        data: TrainingOpsLearningSeriesImportSummary
    }> {
        return this.request('/admin/training-ops/series/import', {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    static async getTrainingOpsBadgeMilestones(params: Record<string, string | number | boolean | undefined> = {}): Promise<{
        success: boolean
        data: BadgeMilestoneSummary[]
        pagination: {
            page: number
            limit: number
            total: number
            totalPages: number
        }
    }> {
        const query = new URLSearchParams()
        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== null && value !== '') {
                query.set(key, String(value))
            }
        })
        const search = query.toString() ? `?${query.toString()}` : ''
        return this.request(`/admin/training-ops/badges${search}`)
    }

    static async getTrainingOpsBadgeMilestone(id: string): Promise<{
        success: boolean
        data: BadgeMilestoneSummary
    }> {
        return this.request(`/admin/training-ops/badges/${id}`)
    }

    static async createTrainingOpsBadgeMilestone(payload: {
        name: string
        slug: string
        description?: string | null
        icon?: string | null
        thresholdStars: number
        active: boolean
        domainId: string
    }): Promise<{
        success: boolean
        data: BadgeMilestoneSummary
    }> {
        return this.request('/admin/training-ops/badges', {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    static async updateTrainingOpsBadgeMilestone(id: string, payload: {
        name?: string
        slug?: string
        description?: string | null
        icon?: string | null
        thresholdStars?: number
        active?: boolean
        domainId?: string | null
    }): Promise<{
        success: boolean
        data: BadgeMilestoneSummary
    }> {
        return this.request(`/admin/training-ops/badges/${id}`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
        })
    }

    static async importTrainingOpsBadgeMilestones(payload: {
        payload: unknown
        apply?: boolean
    }): Promise<{
        success: boolean
        data: TrainingOpsBadgeImportSummary
    }> {
        return this.request('/admin/training-ops/badges/import', {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    static async getTrainingOpsEvents(params: Record<string, string | number | boolean | undefined> = {}): Promise<{
        success: boolean
        data: LearningEventSummary[]
        pagination: {
            page: number
            limit: number
            total: number
            totalPages: number
        }
    }> {
        const query = new URLSearchParams()
        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== null && value !== '') {
                query.set(key, String(value))
            }
        })
        const search = query.toString() ? `?${query.toString()}` : ''
        return this.request(`/admin/training-ops/events${search}`)
    }

    static async createTrainingOpsEvent(payload: {
        title: string
        format: LearningEventSummary['format']
        status: LearningEventSummary['status']
        seriesId?: string | null
        domainId?: string | null
        description?: string | null
        scheduledAt?: string | null
        isRequired: boolean
        countsTowardPerformance: boolean
        hostId?: string | null
    }): Promise<{
        success: boolean
        data: LearningEventSummary
    }> {
        return this.request('/admin/training-ops/events', {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    static async getTrainingOpsEvent(eventId: string): Promise<{
        success: boolean
        data: LearningEventSummary
    }> {
        return this.request(`/admin/training-ops/events/${eventId}`)
    }

    static async updateTrainingOpsEvent(eventId: string, payload: Partial<{
        title: string
        format: LearningEventSummary['format']
        status: LearningEventSummary['status']
        seriesId?: string | null
        domainId?: string | null
        description?: string | null
        scheduledAt?: string | null
        isRequired: boolean
        countsTowardPerformance: boolean
        hostId?: string | null
    }>): Promise<{
        success: boolean
        data: LearningEventSummary
    }> {
        return this.request(`/admin/training-ops/events/${eventId}`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
        })
    }

    static async deleteTrainingOpsEvent(eventId: string): Promise<{
        success: boolean
        data: { id: string }
    }> {
        return this.request(`/admin/training-ops/events/${eventId}`, {
            method: 'DELETE',
        })
    }

    static async deleteTrainingOpsSeries(seriesId: string): Promise<{
        success: boolean
        data: { id: string }
    }> {
        return this.request(`/admin/training-ops/series/${seriesId}`, {
            method: 'DELETE',
        })
    }

    static async deleteTrainingOpsDomain(domainId: string): Promise<{
        success: boolean
        data: { id: string }
    }> {
        return this.request(`/admin/training-ops/domains/${domainId}`, {
            method: 'DELETE',
        })
    }

    static async attachExamToTrainingOpsEvent(eventId: string, payload: { examId: string }): Promise<{
        success: boolean
        data: LearningEventSummary
    }> {
        return this.request(`/admin/training-ops/events/${eventId}/exams`, {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    static async detachExamFromTrainingOpsEvent(eventId: string, examId: string): Promise<{
        success: boolean
        data: LearningEventSummary
    }> {
        return this.request(`/admin/training-ops/events/${eventId}/exams/${examId}`, {
            method: 'DELETE',
        })
    }

    static async attachCourseToTrainingOpsEvent(eventId: string, payload: { courseId: string }): Promise<{
        success: boolean
        data: LearningEventSummary
    }> {
        return this.request(`/admin/training-ops/events/${eventId}/courses`, {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    static async detachCourseFromTrainingOpsEvent(eventId: string, courseId: string): Promise<{
        success: boolean
        data: LearningEventSummary
    }> {
        return this.request(`/admin/training-ops/events/${eventId}/courses/${courseId}`, {
            method: 'DELETE',
        })
    }

    static async getSmeTrainingOpsOverview(): Promise<{
        success: boolean
        data: SmeWorkspaceSummary
    }> {
        return this.request('/sme/training-ops/overview')
    }

    static async getSmeTrainingOpsDomains(): Promise<{
        success: boolean
        data: ProductDomainSummary[]
    }> {
        return this.request('/sme/training-ops/domains')
    }

    static async getSmeTrainingOpsSeries(): Promise<{
        success: boolean
        data: LearningSeriesSummary[]
    }> {
        return this.request('/sme/training-ops/series')
    }

    static async createSmeTrainingOpsSeries(payload: {
        name: string
        slug: string
        type: LearningSeriesSummary['type']
        domainId?: string | null
        ownerId?: string | null
        description?: string | null
        cadence?: string | null
        isActive: boolean
        countsTowardPerformance?: boolean
        defaultStarValue?: number | null
    }): Promise<{
        success: boolean
        data: LearningSeriesSummary
    }> {
        return this.request('/sme/training-ops/series', {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    static async getSmeTrainingOpsSeriesById(id: string): Promise<{
        success: boolean
        data: LearningSeriesSummary
    }> {
        return this.request(`/sme/training-ops/series/${id}`)
    }

    static async updateSmeTrainingOpsSeries(id: string, payload: {
        name?: string
        slug?: string
        type?: LearningSeriesSummary['type']
        domainId?: string | null
        description?: string | null
        cadence?: string | null
        isActive?: boolean
        countsTowardPerformance?: boolean
        defaultStarValue?: number | null
        ownerId?: string | null
    }): Promise<{
        success: boolean
        data: LearningSeriesSummary
    }> {
        return this.request(`/sme/training-ops/series/${id}`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
        })
    }

    static async getSmeTrainingOpsBadges(): Promise<{
        success: boolean
        data: SmeBadgeLadderOverview
    }> {
        return this.request('/sme/training-ops/badges')
    }

    static async getSmeTrainingOpsBadgeMilestone(id: string): Promise<{
        success: boolean
        data: BadgeMilestoneSummary
    }> {
        return this.request(`/sme/training-ops/badges/${id}`)
    }

    static async createSmeTrainingOpsBadgeMilestone(payload: {
        name: string
        slug: string
        description?: string | null
        icon?: string | null
        thresholdStars: number
        active: boolean
        domainId: string
    }): Promise<{
        success: boolean
        data: BadgeMilestoneSummary
    }> {
        return this.request('/sme/training-ops/badges', {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    static async updateSmeTrainingOpsBadgeMilestone(id: string, payload: {
        name?: string
        slug?: string
        description?: string | null
        icon?: string | null
        thresholdStars?: number
        active?: boolean
        domainId?: string | null
    }): Promise<{
        success: boolean
        data: BadgeMilestoneSummary
    }> {
        return this.request(`/sme/training-ops/badges/${id}`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
        })
    }

    static async getSmeTrainingOpsEffectiveness(): Promise<{
        success: boolean
        data: ProductDomainEffectivenessSummary[]
    }> {
        return this.request('/sme/training-ops/effectiveness')
    }

    static async getSmeTrainingOpsLearnerGaps(): Promise<{
        success: boolean
        data: SmeWorkspaceSummary['learnerGaps']
    }> {
        return this.request('/sme/training-ops/learner-gaps')
    }

    static async getSmeLearnerGapDrilldown(params: {
        kind: 'topic'
        topic: string
        domainId: string
    } | {
        kind: 'learner'
        userId: string
    }): Promise<{
        success: boolean
        data: import('@/types').SmeLearnerGapDrilldown
    }> {
        const query = new URLSearchParams(params)
        return this.request(`/sme/training-ops/learner-gaps/drilldown?${query.toString()}`)
    }

    static async getSmeTrainingOpsHosts(): Promise<{
        success: boolean
        data: AdminUser[]
    }> {
        return this.request('/sme/training-ops/hosts')
    }

    static async getSmeTrainingOpsExams(): Promise<{
        success: boolean
        data: TrainingOpsExamSummary[]
    }> {
        return this.request('/sme/training-ops/exams')
    }

    static async getSmeTrainingOpsExam(examId: string): Promise<{
        success: boolean
        data: SmeManagedExamDetail
    }> {
        return this.request(`/sme/training-ops/exams/${examId}`)
    }

    static async getSmeTrainingOpsCourses(): Promise<{
        success: boolean
        data: TrainingOpsCourseSummary[]
    }> {
        return this.request('/sme/training-ops/courses')
    }

    static async getSmeTrainingOpsCourse(courseId: string): Promise<{
        success: boolean
        data: SmeManagedCourseDetail
    }> {
        return this.request(`/sme/training-ops/courses/${courseId}`)
    }

    static async getSmeTrainingOpsEvents(params: Record<string, string | number | boolean | undefined> = {}): Promise<{
        success: boolean
        data: LearningEventSummary[]
    }> {
        const query = new URLSearchParams()
        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== null && value !== '') {
                query.set(key, String(value))
            }
        })
        const search = query.toString() ? `?${query.toString()}` : ''
        return this.request(`/sme/training-ops/events${search}`)
    }

    static async getSmeTrainingOpsEvent(eventId: string): Promise<{
        success: boolean
        data: LearningEventSummary
    }> {
        return this.request(`/sme/training-ops/events/${eventId}`)
    }

    static async createSmeTrainingOpsEvent(payload: {
        title: string
        format: LearningEventSummary['format']
        status: LearningEventSummary['status']
        seriesId?: string | null
        domainId?: string | null
        description?: string | null
        scheduledAt?: string | null
        isRequired: boolean
        countsTowardPerformance: boolean
        hostId?: string | null
    }): Promise<{
        success: boolean
        data: LearningEventSummary
    }> {
        return this.request('/sme/training-ops/events', {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    static async updateSmeTrainingOpsEvent(eventId: string, payload: Partial<{
        title: string
        format: LearningEventSummary['format']
        status: LearningEventSummary['status']
        seriesId?: string | null
        domainId?: string | null
        description?: string | null
        scheduledAt?: string | null
        isRequired: boolean
        countsTowardPerformance: boolean
        hostId?: string | null
    }>): Promise<{
        success: boolean
        data: LearningEventSummary
    }> {
        return this.request(`/sme/training-ops/events/${eventId}`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
        })
    }

    static async deleteSmeTrainingOpsEvent(eventId: string, options?: {
        cascadeDraftAssets?: boolean
    }): Promise<{
        success: boolean
        data: { id: string }
    }> {
        const search = new URLSearchParams()
        if (options?.cascadeDraftAssets) {
            search.set('cascadeDraftAssets', '1')
        }

        return this.request(`/sme/training-ops/events/${eventId}${search.toString() ? `?${search.toString()}` : ''}`, {
            method: 'DELETE',
        })
    }

    static async attachExamToSmeTrainingOpsEvent(eventId: string, payload: { examId: string }): Promise<{
        success: boolean
        data: LearningEventSummary
    }> {
        return this.request(`/sme/training-ops/events/${eventId}/exams`, {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    static async detachExamFromSmeTrainingOpsEvent(eventId: string, examId: string): Promise<{
        success: boolean
        data: LearningEventSummary
    }> {
        return this.request(`/sme/training-ops/events/${eventId}/exams/${examId}`, {
            method: 'DELETE',
        })
    }

    static async attachCourseToSmeTrainingOpsEvent(eventId: string, payload: { courseId: string }): Promise<{
        success: boolean
        data: LearningEventSummary
    }> {
        return this.request(`/sme/training-ops/events/${eventId}/courses`, {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    static async detachCourseFromSmeTrainingOpsEvent(eventId: string, courseId: string): Promise<{
        success: boolean
        data: LearningEventSummary
    }> {
        return this.request(`/sme/training-ops/events/${eventId}/courses/${courseId}`, {
            method: 'DELETE',
        })
    }

    static async createDraftExamFromSmeTrainingOpsEvent(eventId: string): Promise<{
        success: boolean
        data: Exam
    }> {
        return this.request(`/sme/training-ops/events/${eventId}/draft-exam`, {
            method: 'POST',
        })
    }

    static async createDraftCourseFromSmeTrainingOpsEvent(eventId: string): Promise<{
        success: boolean
        data: Course
    }> {
        return this.request(`/sme/training-ops/events/${eventId}/draft-course`, {
            method: 'POST',
        })
    }

    static async getProgressOverview(): Promise<{
        success: boolean
        data: UserProgressOverview
    }> {
        return this.request('/progress/overview')
    }

    static async getLearnerRewardsOverview(): Promise<{
        success: boolean
        data: LearnerRewardsOverview
    }> {
        return this.request('/rewards')
    }

    static async getLearnerTrainingOverview(): Promise<{
        success: boolean
        data: LearnerTrainingOverview
    }> {
        return this.request('/training')
    }

    // Progress
    static async getCourseProgress(courseId: string): Promise<{
        success: boolean
        data: {
            courseId: string
            overallProgress: number
            completedLessons: number
            totalLessons: number
            lessonProgress: LessonProgress[]
        }
    }> {
        return this.request(`/progress/courses/${courseId}`)
    }

    static async updateLessonProgress(
        lessonId: string,
        payload: {
            watchedDuration: number
            lastTimestamp: number
            completed?: boolean
        }
    ) {
        return this.request(`/progress/lessons/${lessonId}`, {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    // AI assistant
    static async createConversation(payload: { courseId?: string; lessonId?: string }) {
        return this.request(`/ai/conversations`, {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    static async getConversationMessages(conversationId: string) {
        return this.request(`/ai/conversations/${conversationId}/messages`)
    }

    static async sendAIMessage(
        conversationId: string,
        payload: {
            message: string
            videoTimestamp?: number
            context?: Record<string, unknown>
        }
    ) {
        return this.request(`/ai/conversations/${conversationId}/messages`, {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    static async runLearningAgentAction(payload:
        | {
            action: 'lesson_coach'
            courseId: string
            lessonId: string
            currentTimestamp?: number
        }
        | {
            action: 'exam_mistake_review'
            examId: string
            attemptId?: string | null
        }
        | {
            action: 'learning_plan'
        }
    ): Promise<{
        success: boolean
        data: {
            action: 'lesson_coach' | 'exam_mistake_review' | 'learning_plan'
            answer: string
            model: string
            provider: string
            metadata: Record<string, unknown>
        }
    }> {
        return this.request('/learning-agent/actions', {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    // ========== Admin Exams ==========

    static async getAdminExams(params: Record<string, string | number | undefined> = {}): Promise<{
        success: boolean
        data: Exam[]
        pagination: {
            page: number
            limit: number
            total: number
            totalPages: number
        }
    }> {
        const query = new URLSearchParams()
        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== null) {
                query.set(key, String(value))
            }
        })
        const search = query.toString() ? `?${query.toString()}` : ''
        return this.request(`/admin/exams${search}`)
    }

    static async getAdminExam(examId: string): Promise<{ success: boolean; data: Exam }> {
        return this.request(`/admin/exams/${examId}`)
    }

    static async createExam(payload: {
        title: string
        courseId?: string | null
        description?: string
        instructions?: string
        timeLimit?: number
        totalScore?: number
        passingScore?: number
        maxAttempts?: number
        randomizeQuestions?: boolean
        randomizeOptions?: boolean
        showResultsImmediately?: boolean
        allowReview?: boolean
        timezone: string
        availableFrom?: string
        deadline?: string
        assessmentKind?: 'PRACTICE' | 'READINESS' | 'FORMAL'
        productDomainId?: string | null
        learningSeriesId?: string | null
        learningEventId?: string | null
        awardsStars?: boolean
        starValue?: number | null
        countsTowardPerformance?: boolean
    }): Promise<{ success: boolean; data: Exam }> {
        return this.request('/admin/exams', {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    static async updateExam(examId: string, payload: Partial<{
        courseId: string | null
        learningEventId: string | null
        title: string
        description: string | null
        instructions: string | null
        timeLimit: number | null
        totalScore: number
        passingScore: number
        maxAttempts: number
        randomizeQuestions: boolean
        randomizeOptions: boolean
        showResultsImmediately: boolean
        allowReview: boolean
        timezone: string
        availableFrom: string | null
        deadline: string | null
        assessmentKind: 'PRACTICE' | 'READINESS' | 'FORMAL'
        awardsStars: boolean
        starValue: number | null
        countsTowardPerformance: boolean
    }>): Promise<{ success: boolean; data: Exam }> {
        return this.request(`/admin/exams/${examId}`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
        })
    }

    static async deleteExam(examId: string): Promise<{ success: boolean; message: string }> {
        return this.request(`/admin/exams/${examId}`, {
            method: 'DELETE',
        })
    }

    static async deleteExamForce(examId: string): Promise<{ success: boolean; message: string }> {
        return this.request(`/admin/exams/${examId}?force=1`, {
            method: 'DELETE',
        })
    }

    static async updateExamStatus(examId: string, status: ExamStatus): Promise<{ success: boolean; data: Exam }> {
        return this.request(`/admin/exams/${examId}/status`, {
            method: 'POST',
            body: JSON.stringify({ status }),
        })
    }

    static async publishExam(examId: string, payload: { userIds: string[]; sendNotification?: boolean; sendEmail?: boolean }): Promise<{ success: boolean; data: Exam; meta?: { invited: number; skipped: number; existingInvitations?: number; notificationsSent?: number; notificationsFailed?: number; emailsSent?: number; emailsFailed?: number } }> {
        return this.request(`/admin/exams/${examId}/publish`, {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    // Exam Certificate Template
    static async getAdminExamCertificateTemplate(examId: string): Promise<{
        success: boolean
        data: {
            id: string
            examId: string
            isEnabled: boolean
            title: string
            badgeMode: 'AUTO' | 'UPLOADED'
            badgeS3Key?: string | null
            badgeMimeType?: string | null
            badgeStyle?: Record<string, unknown> | null
            createdAt: string | Date
            updatedAt: string | Date
        } | null
    }> {
        return this.request(`/admin/exams/${examId}/certificate-template`)
    }

    static async upsertAdminExamCertificateTemplate(
        examId: string,
        payload: {
            isEnabled: boolean
            title: string
            badgeMode: 'AUTO' | 'UPLOADED'
            badgeS3Key?: string | null
            badgeMimeType?: string | null
            badgeStyle?: Record<string, unknown> | null
        }
    ): Promise<{ success: boolean; data: unknown }> {
        return this.request(`/admin/exams/${examId}/certificate-template`, {
            method: 'PUT',
            body: JSON.stringify(payload),
        })
    }

    static async getAdminExamCertificateBadgeUploadUrl(
        examId: string,
        payload: { filename: string; contentType: 'image/png' | 'image/jpeg' }
    ): Promise<{ success: boolean; data: { uploadUrl: string; key: string; bucket: string; publicUrl: string; accessUrl: string; expiresIn: number } }> {
        return this.request(`/admin/exams/${examId}/certificate-template/badge-upload-url`, {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    // Exam Questions
    static async getExamQuestions(examId: string): Promise<{ success: boolean; data: ExamQuestion[] }> {
        return this.request(`/admin/exams/${examId}/questions`)
    }

    static async createExamQuestion(examId: string, payload: {
        type: ExamQuestionType
        question: string
        options?: string[]
        correctAnswer?: string
        explanation?: string
        points: number
        order?: number
        difficulty?: 'EASY' | 'MEDIUM' | 'HARD'
        maxWords?: number
        rubric?: string
        sampleAnswer?: string
        gradingCriteria?: EssayGradingCriterion[] | null
        attachmentS3Key?: string | null
        attachmentFilename?: string | null
        attachmentMimeType?: string | null
    }): Promise<{ success: boolean; data: ExamQuestion }> {
        return this.request(`/admin/exams/${examId}/questions`, {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    static async updateExamQuestion(examId: string, questionId: string, payload: Partial<{
        type: ExamQuestionType
        question: string
        options: string[]
        correctAnswer: string
        explanation: string
        points: number
        order: number
        difficulty: 'EASY' | 'MEDIUM' | 'HARD'
        maxWords: number
        rubric: string
        sampleAnswer: string
        gradingCriteria: EssayGradingCriterion[] | null
        attachmentS3Key: string | null
        attachmentFilename: string | null
        attachmentMimeType: string | null
    }>): Promise<{ success: boolean; data: ExamQuestion }> {
        return this.request(`/admin/exams/${examId}/questions/${questionId}`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
        })
    }

    static async getAdminExamQuestionAttachmentUploadUrl(examId: string, questionId: string, payload: {
        filename: string
        contentType: string
    }): Promise<{
        success: boolean
        data: {
            uploadUrl: string
            key: string
            bucket: string
            publicUrl: string
            accessUrl: string
            expiresIn: number
        }
    }> {
        return this.request(`/admin/exams/${examId}/questions/${questionId}/attachment-upload-url`, {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    static async getAdminExamRichContentUploadUrl(examId: string, payload: {
        filename: string
        contentType: string
    }): Promise<{
        success: boolean
        data: {
            uploadUrl: string
            key: string
            bucket: string
            accessUrl: string
            expiresIn: number
        }
    }> {
        return this.request(`/admin/exams/${examId}/rich-content-upload-url`, {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    static async deleteExamQuestion(examId: string, questionId: string): Promise<{ success: boolean; message: string }> {
        return this.request(`/admin/exams/${examId}/questions/${questionId}`, {
            method: 'DELETE',
        })
    }

    static async reorderExamQuestions(examId: string, questionOrder: string[]): Promise<{ success: boolean; data: ExamQuestion[] }> {
        return this.request(`/admin/exams/${examId}/questions/reorder`, {
            method: 'PATCH',
            body: JSON.stringify({ questionOrder }),
        })
    }

    static async generateExamQuestions(examId: string, config: {
        questionCounts: {
            singleChoice?: number
            multipleChoice?: number
            trueFalse?: number
            fillInBlank?: number
            essay?: number
        }
        difficulty?: 'EASY' | 'MEDIUM' | 'HARD' | 'mixed'
        choiceOptionCount?: 4 | 5 | 6
        lessonIds?: string[]
        topics?: string[]
    }): Promise<{ success: boolean; data: ExamQuestion[] }> {
        return this.request(`/admin/exams/${examId}/generate-questions`, {
            method: 'POST',
            body: JSON.stringify(config),
        })
    }

    static async getExamKnowledgeContexts(examId: string): Promise<{
        success: boolean
        data: {
            courseId: string | null
            lessons: Array<{
                lessonId: string
                lessonTitle: string
                chapterTitle: string
                chapterOrder: number
                lessonOrder: number
                knowledgeStatus: string
                anchorCount: number
                processedAt: string | null
                hasTranscript: boolean
                transcriptId: string | null
                transcriptFilename: string | null
            }>
        }
    }> {
        return this.request(`/admin/exams/${examId}/knowledge-contexts`)
    }

    // Exam Invitations
    static async getExamInvitations(examId: string): Promise<{ success: boolean; data: ExamInvitation[] }> {
        return this.request(`/admin/exams/${examId}/invitations`)
    }

    static async createExamInvitations(examId: string, userIds: string[], opts?: { sendNotification?: boolean; sendEmail?: boolean }): Promise<{ success: boolean; data: { invited: number; skipped: number; notificationsSent?: number; notificationsFailed?: number; emailsSent?: number; emailsFailed?: number } }> {
        return this.request(`/admin/exams/${examId}/invitations`, {
            method: 'POST',
            body: JSON.stringify({
                userIds,
                sendNotification: opts?.sendNotification,
                sendEmail: opts?.sendEmail,
            }),
        })
    }

    static async sendExamInvitationNotifications(examId: string, userIds?: string[]): Promise<{ success: boolean; data: { sent: number; failed: number } }> {
        return this.request(`/admin/exams/${examId}/invitations/send`, {
            method: 'POST',
            body: JSON.stringify({ userIds }),
        })
    }

    // Backward-compatible alias
    static async sendExamInvitationEmails(examId: string, userIds?: string[]): Promise<{ success: boolean; data: { sent: number; failed: number } }> {
        return this.sendExamInvitationNotifications(examId, userIds)
    }

    // Course Invitations
    static async getCourseInvitations(courseId: string): Promise<{ success: boolean; data: CourseInvitation[] }> {
        return this.request(`/admin/courses/${courseId}/invitations`)
    }

    static async createCourseInvitations(courseId: string, userIds: string[], opts?: { sendNotification?: boolean; sendEmail?: boolean }): Promise<{ success: boolean; data: { invited: number; skipped: number; notificationsSent?: number; notificationsFailed?: number; emailsSent?: number; emailsFailed?: number } }> {
        return this.request(`/admin/courses/${courseId}/invitations`, {
            method: 'POST',
            body: JSON.stringify({
                userIds,
                sendNotification: opts?.sendNotification,
                sendEmail: opts?.sendEmail,
            }),
        })
    }

    static async sendCourseInvitationNotifications(courseId: string, userIds?: string[]): Promise<{ success: boolean; data: { sent: number; failed: number } }> {
        return this.request(`/admin/courses/${courseId}/invitations/send`, {
            method: 'POST',
            body: JSON.stringify({ userIds }),
        })
    }

    // Exam Attempts (Admin)
    static async getExamAttempts(examId: string, params: Record<string, string | number | undefined> = {}): Promise<{
        success: boolean
        data: ExamAttempt[]
        pagination: {
            page: number
            limit: number
            total: number
            totalPages: number
        }
    }> {
        const query = new URLSearchParams()
        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== null) {
                query.set(key, String(value))
            }
        })
        const search = query.toString() ? `?${query.toString()}` : ''
        return this.request(`/admin/exams/${examId}/attempts${search}`)
    }

    static async getExamAttemptDetail(examId: string, attemptId: string): Promise<{
        success: boolean
        data: ExamAttempt & {
            answers: Array<{
                id: string
                questionId: string
                answer?: string | null
                selectedOption?: number | null
                recordingS3Key?: string | null
                recordingStatus?: 'PENDING_UPLOAD' | 'UPLOADED' | 'FAILED' | null
                recordingMimeType?: string | null
                recordingSizeBytes?: number | null
                recordingDurationSeconds?: number | null
                recordingUrl?: string | null
                gradingStatus: string
                isCorrect?: boolean | null
                pointsAwarded?: number | null
                aiSuggestedScore?: number | null
                aiFeedback?: string | null
                aiGradingBreakdown?: EssayAIGradingBreakdown | null
                adminScore?: number | null
                adminFeedback?: string | null
                question: ExamQuestion
            }>
            certificate?: {
                id: string
                certificateNumber: string
                issueDate: string | Date
                pdfUrl: string | null
                status: 'ISSUED' | 'REVOKED'
                revokedAt?: string | Date | null
                certificateTitle?: string | null
            } | null
        }
    }> {
        return this.request(`/admin/exams/${examId}/attempts/${attemptId}`)
    }

    // Essay Grading
    static async getEssaysToGrade(examId: string): Promise<{
        success: boolean
        data: Array<{
            attemptId: string
            answerId: string
            userId: string
            userName: string
            questionId: string
            question: string
            answer: string
            points: number
            aiSuggestedScore?: number | null
            aiFeedback?: string | null
            aiGradingBreakdown?: EssayAIGradingBreakdown | null
            rubric?: string | null
            sampleAnswer?: string | null
            gradingCriteria?: EssayGradingCriterion[] | null
        }>
    }> {
        return this.request(`/admin/exams/${examId}/essays`)
    }

    static async gradeEssay(examId: string, attemptId: string, answerId: string, payload: {
        score: number
        feedback?: string
    }): Promise<{ success: boolean; data: { answerId: string; score: number } }> {
        return this.request(`/admin/exams/${examId}/attempts/${attemptId}/grade-essay`, {
            method: 'POST',
            body: JSON.stringify({ answerId, ...payload }),
        })
    }

    static async triggerAutoGrade(examId: string, attemptId: string): Promise<{ success: boolean; data: ExamAttempt }> {
        return this.request(`/admin/exams/${examId}/attempts/${attemptId}/grade`, {
            method: 'POST',
        })
    }

    // Exam Analytics
    static async getExamAnalytics(examId: string): Promise<{ success: boolean; data: ExamAnalytics }> {
        const response = (await this.request(`/admin/exams/${examId}/analytics`)) as {
            success: boolean
            data: ExamAnalytics & {
                summary?: {
                    totalAttempts?: number
                    uniqueUsers?: number
                    averageScore?: number
                    medianScore?: number | null
                    maxScore?: number
                    minScore?: number
                    passedCount?: number
                    failedCount?: number
                    averageCompletionTime?: number | null
                }
                examId?: string
            }
        }
        const raw = response?.data

        // Backward/forward compatibility:
        // - Some API versions return a flat `ExamAnalytics` object
        // - The current backend returns a comprehensive object: `{ examId, examTitle, summary: {...} }`
        if (raw?.summary) {
            return {
                ...response,
                data: {
                    examId: raw.examId ?? examId,
                    totalAttempts: raw.summary.totalAttempts ?? 0,
                    uniqueUsers: raw.summary.uniqueUsers ?? 0,
                    avgScore: raw.summary.averageScore ?? 0,
                    medianScore: raw.summary.medianScore ?? null,
                    highestScore: raw.summary.maxScore ?? 0,
                    lowestScore: raw.summary.minScore ?? 0,
                    passCount: raw.summary.passedCount ?? 0,
                    failCount: raw.summary.failedCount ?? 0,
                    avgCompletionTime: raw.summary.averageCompletionTime ?? null,
                    lastUpdatedAt: new Date().toISOString(),
                } satisfies ExamAnalytics,
            }
        }

        return response
    }

    static async exportExamResults(examId: string): Promise<Blob> {
        const token = this.getToken()
        const response = await fetch(`/api/admin/exams/${examId}/export`, {
            headers: {
                Authorization: token ? `Bearer ${token}` : '',
            },
        })

        if (!response.ok) {
            throw new Error('Failed to export results')
        }

        return response.blob()
    }

    static async exportExamContent(examId: string): Promise<Blob> {
        const token = this.getToken()
        const response = await fetch(`/api/admin/exams/${examId}/content-export`, {
            headers: {
                Authorization: token ? `Bearer ${token}` : '',
            },
        })

        if (!response.ok) {
            throw new Error('Failed to export exam content')
        }

        return response.blob()
    }

    static async getExamLeaderboard(examId: string, limit?: number): Promise<{
        success: boolean
        data: {
            examId: string
            examTitle: string
            leaderboard: Array<{
                rank: number
                userId: string
                userName: string
                score: number
                percentageScore: number
                completedAt: string
            }>
        }
    }> {
        const query = limit ? `?limit=${limit}` : ''
        const response = (await this.request(`/admin/exams/${examId}/leaderboard${query}`)) as {
            success: boolean
            data?: {
                examId?: string
                examTitle?: string
                leaderboard?: Array<{
                    rank: number
                    userId: string
                    userName: string
                    score?: number
                    bestScore?: number
                    percentageScore?: number
                    completedAt: string
                }>
            }
        }
        const leaderboard = Array.isArray(response?.data?.leaderboard) ? response.data.leaderboard : []
        const normalized = leaderboard.map((entry) => ({
            rank: entry.rank,
            userId: entry.userId,
            userName: entry.userName,
            score: entry.score ?? entry.bestScore ?? 0,
            percentageScore: entry.percentageScore ?? entry.bestScore ?? entry.score ?? 0,
            completedAt: entry.completedAt,
        }))

        return {
            ...response,
            data: {
                examId: response?.data?.examId ?? examId,
                examTitle: response?.data?.examTitle ?? '',
                leaderboard: normalized,
            },
        }
    }

    // ========== User Exams ==========

    static async getAvailableExams(): Promise<{
        success: boolean
        data: Array<Exam & {
            assessmentKind?: 'PRACTICE' | 'READINESS' | 'FORMAL'
            awardsStars?: boolean
            starValue?: number | null
            countsTowardPerformance?: boolean
            certificateEligible?: boolean
            userAttempts: number
            bestScore: number | null
            hasPassed: boolean
            attemptResults?: Array<{
                id: string
                attemptNumber: number
                status: string
                percentageScore: number | null
                passed: boolean | null
                submittedAt: string | null
            }>
        }>
    }> {
        return this.request('/exams')
    }

    static async getExamDetails(examId: string): Promise<{
        success: boolean
        data: Exam & {
            questionsCount: number
            certificateEligible?: boolean
            userAttempts: Array<{
                id: string
                attemptNumber: number
                status: string
                percentageScore: number | null
                passed: boolean | null
                submittedAt: string | null
            }>
            canAttempt: boolean
            remainingAttempts: number
        }
    }> {
        return this.request(`/exams/${examId}`)
    }

    static async startExamAttempt(examId: string): Promise<{
        success: boolean
        data: {
            attemptId: string
            examId: string
            attemptNumber: number
            startedAt: string
            expiresAt: string | null
            timeLimit: number | null
            totalQuestions: number
            questions: Array<{
                id: string
                type: ExamQuestionType
                question: string
                options: string[] | null
                points: number
                order: number
                maxWords?: number
                attachmentFilename?: string | null
                attachmentMimeType?: string | null
                attachmentUrl?: string | null
            }>
        }
    }> {
        return this.request(`/exams/${examId}/start`, {
            method: 'POST',
        })
    }

    static async saveExamAnswer(examId: string, payload: {
        attemptId: string
        questionId: string
        answer?: string
        selectedOption?: number
    }): Promise<{ success: boolean }> {
        return this.request(`/exams/${examId}/answer`, {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    static async createExerciseUploadUrl(examId: string, payload: {
        attemptId: string
        questionId: string
    }): Promise<{ success: boolean; data: { uploadUrl: string; key: string; bucket: string; contentType: string; expiresIn: number } }> {
        return this.request(`/exams/${examId}/exercise/upload-url`, {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    static async createExamRichContentUploadUrl(examId: string, attemptId: string, payload: {
        questionId: string
        filename: string
        contentType: string
    }): Promise<{
        success: boolean
        data: {
            uploadUrl: string
            key: string
            bucket: string
            accessUrl: string
            expiresIn: number
        }
    }> {
        return this.request(`/exams/${examId}/attempts/${attemptId}/rich-content-upload-url`, {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    static async confirmExerciseUpload(examId: string, payload: {
        attemptId: string
        questionId: string
        durationSeconds?: number
    }): Promise<{ success: boolean; data: { answerId: string; recordingS3Key: string; bucket: string; recordingMimeType: string | null; recordingSizeBytes: number | null } }> {
        return this.request(`/exams/${examId}/exercise/confirm`, {
            method: 'POST',
            body: JSON.stringify(payload),
        })
    }

    static async getExerciseAccessUrl(examId: string, payload: {
        attemptId: string
        questionId: string
    }): Promise<{ success: boolean; data: { url: string } }> {
        const qs = new URLSearchParams(payload).toString()
        return this.request(`/exams/${examId}/exercise/access-url?${qs}`)
    }

    static async submitExam(examId: string, attemptId: string): Promise<{
        success: boolean
        data: {
            attemptId: string
            status: string
            rawScore: number | null
            percentageScore: number | null
            passed: boolean | null
            totalQuestions: number
            correctAnswers: number
            showResults: boolean
        }
    }> {
        return this.request(`/exams/${examId}/submit`, {
            method: 'POST',
            body: JSON.stringify({ attemptId }),
        })
    }

    static async getExamResult(examId: string, attemptId?: string): Promise<{
        success: boolean
        data: {
            attemptId: string
            examId: string
            examTitle: string
            attemptNumber: number
            status: string
            startedAt: string
            submittedAt: string | null
            rawScore: number | null
            percentageScore: number | null
            passed: boolean | null
            totalScore: number
            passingScore: number
            allowReview: boolean
            assessmentKind?: 'PRACTICE' | 'READINESS' | 'FORMAL' | null
            awardsStars: boolean
            starValue?: number | null
            countsTowardPerformance: boolean
            maxAttempts: number
            attemptsUsed: number
            reviewUnlocked: boolean
            reviewUnlockedByPassing?: boolean
            reviewUnlockedByAttempts?: boolean
            reviewUnlockedByDeadline?: boolean
            rewardOutcome: {
                starsEarned: number
                badgesUnlocked: Array<{
                    id: string
                    name: string
                    slug: string
                    description: string | null
                    domain?: {
                        id: string
                        name: string
                        slug: string
                    } | null
                }>
                certificate: {
                    eligible: boolean
                    issued: boolean
                    id: string | null
                    title: string | null
                    certificateNumber: string | null
                }
            }
            answers?: Array<{
                questionId: string
                question: string
                type: ExamQuestionType
                userAnswer: string | null
                selectedOption: number | null
                correctAnswer: string | null
                isCorrect: boolean | null
                pointsAwarded: number | null
                maxPoints: number
                explanation: string | null
                feedback?: string | null
            }>
        }
    }> {
        const query = attemptId ? `?attemptId=${attemptId}` : ''
        return this.request(`/exams/${examId}/result${query}`)
    }

    static async getUserExamAttempts(examId: string): Promise<{
        success: boolean
        data: Array<{
            id: string
            attemptNumber: number
            status: string
            startedAt: string
            submittedAt: string | null
            percentageScore: number | null
            passed: boolean | null
        }>
    }> {
        return this.request(`/exams/${examId}/attempts`)
    }

    static async getCurrentAttempt(examId: string): Promise<{
        success: boolean
        data: {
            attemptId: string
            examId: string
            attemptNumber: number
            startedAt: string
            expiresAt: string | null
            timeLimit: number | null
            totalQuestions: number
            questions: Array<{
                id: string
                type: ExamQuestionType
                question: string
                options: string[] | null
                points: number
                order: number
                maxWords?: number
                attachmentFilename?: string | null
                attachmentMimeType?: string | null
                attachmentUrl?: string | null
            }>
            existingAnswers: Record<string, {
                answer: string | null
                selectedOption: number | null
                recordingS3Key?: string | null
                recordingStatus?: 'PENDING_UPLOAD' | 'UPLOADED' | 'FAILED' | null
            }>
        } | null
    }> {
        return this.request(`/exams/${examId}/current`)
    }

    // ========== Certificates ==========

    static async getUserCertificates(): Promise<{
        success: boolean
        data: Array<{
            id: string
            certificateNumber: string
            userId: string
            userName: string
            courseId: string | null
            courseTitle: string | null
            examId: string | null
            examTitle: string
            score: number
            totalScore: number
            percentageScore: number
            issueDate: string
            pdfUrl: string | null
            status: 'ISSUED' | 'REVOKED'
            revokedAt?: string | null
            certificateTitle?: string | null
            badgeMode?: 'AUTO' | 'UPLOADED' | null
            badgeUrl?: string | null
        }>
    }> {
        return this.request('/certificates')
    }

    static async getCertificate(certificateId: string): Promise<{
        success: boolean
        data: {
            id: string
            certificateNumber: string
            userId: string
            userName: string
            courseId: string | null
            courseTitle: string | null
            examId: string | null
            examTitle: string
            score: number
            totalScore: number
            percentageScore: number
            issueDate: string
            pdfUrl: string | null
            status: 'ISSUED' | 'REVOKED'
            revokedAt?: string | null
            certificateTitle?: string | null
            badgeMode?: 'AUTO' | 'UPLOADED' | null
            badgeUrl?: string | null
            badgeStyle?: Record<string, unknown> | null
        }
    }> {
        return this.request(`/certificates/${certificateId}`)
    }

    static async generateCertificate(attemptId: string, sendEmail = true): Promise<{
        success: boolean
        data: {
            certificate: {
                id: string
                certificateNumber: string
                userName: string
                examTitle: string
                score: number
                totalScore: number
                percentageScore: number
                issueDate: string
                pdfUrl: string | null
                status: 'ISSUED' | 'REVOKED'
            }
            pdfUrl: string | null
            emailSent: boolean
        }
    }> {
        return this.request('/certificates', {
            method: 'POST',
            body: JSON.stringify({ attemptId, sendEmail }),
        })
    }

    static async verifyCertificate(certificateNumber: string): Promise<{
        success: boolean
        data: {
            valid: boolean
            message?: string
            certificate?: {
                certificateNumber: string
                userName: string
                examTitle: string
                issueDate: string
                percentageScore: number
            }
        }
    }> {
        return this.request(`/certificates/verify/${encodeURIComponent(certificateNumber)}`)
    }

    static async adminRevokeCertificate(certificateId: string): Promise<{
        success: boolean
        data: { id: string; status: 'REVOKED'; revokedAt: string; certificateNumber: string }
    }> {
        return this.request(`/admin/certificates/${certificateId}/revoke`, {
            method: 'POST',
            body: JSON.stringify({}),
        })
    }

    static async adminReissueCertificate(certificateId: string): Promise<{
        success: boolean
        data: { id: string; status: 'ISSUED'; issueDate: string; pdfUrl: string | null; certificateNumber: string }
    }> {
        return this.request(`/admin/certificates/${certificateId}/reissue`, {
            method: 'POST',
            body: JSON.stringify({}),
        })
    }
}
