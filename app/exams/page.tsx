'use client'

import { useState, useEffect } from 'react'
import { DashboardLayout } from '@/components/layout/dashboard-layout'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ApiClient } from '@/lib/api-client'
import { buildExamScheduleDisplay } from '@/lib/exam-timezone'
import {
    Loader2,
    Clock,
    FileQuestion,
    CheckCircle,
    XCircle,
    Trophy,
    Play,
    AlertCircle,
    Calendar,
    ChevronDown,
    ChevronUp,
    Eye,
    Search,
    Filter,
    ChevronLeft,
    ChevronRight,
} from 'lucide-react'
import Link from 'next/link'
import type { Exam } from '@/types'

type ExamListItem = Exam & {
    // Backward/forward compatibility with API responses.
    // Newer API returns `questionCount` and `userStatus` instead of `userAttempts/bestScore/hasPassed`.
    questionCount?: number
    userStatus?: {
        completedAttempts: number
        remainingAttempts: number
        hasInProgressAttempt: boolean
        inProgressAttemptId?: string | null
        bestScore?: number | null
        hasPassed: boolean
    }
    userAttempts?: number
    bestScore?: number | null
    hasPassed?: boolean
    attemptResults?: Array<{
        id: string
        attemptNumber: number
        status: string
        percentageScore: number | null
        passed: boolean | null
        submittedAt: string | null
    }>
}

type DateFilter = 'ACTIVE' | 'ALL' | 'UPCOMING' | 'DUE_7_DAYS' | 'EXPIRED' | 'NO_DEADLINE' | 'CUSTOM_CREATED'
type CompletedResultFilter = 'ALL' | 'PASSED' | 'NOT_PASSED' | 'PENDING'

const EXAMS_PER_PAGE = 10

type RawExamListItem = Exam & {
    questionCount?: number
    _count?: { questions?: number }
    userStatus?: {
        completedAttempts: number
        remainingAttempts: number
        hasInProgressAttempt: boolean
        inProgressAttemptId?: string | null
        bestScore?: number | null
        hasPassed: boolean
    }
    userAttempts?: number
    bestScore?: number | null
    hasPassed?: boolean
    attemptResults?: Array<{
        id: string
        attemptNumber: number
        status: string
        percentageScore: number | null
        passed: boolean | null
        submittedAt: string | null
    }>
}

export default function ExamsPage() {
    const [exams, setExams] = useState<ExamListItem[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [expandedExamIds, setExpandedExamIds] = useState<string[]>([])
    const [keywordFilter, setKeywordFilter] = useState('')
    const [labelFilter, setLabelFilter] = useState('ALL')
    const [domainFilter, setDomainFilter] = useState('ALL')
    const [dateFilter, setDateFilter] = useState<DateFilter>('ALL')
    const [createdFromFilter, setCreatedFromFilter] = useState('')
    const [createdToFilter, setCreatedToFilter] = useState('')
    const [dateMenuOpen, setDateMenuOpen] = useState(false)
    const [assignedPage, setAssignedPage] = useState(1)
    const [completedPage, setCompletedPage] = useState(1)
    const [completedKeywordFilter, setCompletedKeywordFilter] = useState('')
    const [completedResultFilter, setCompletedResultFilter] = useState<CompletedResultFilter>('ALL')
    const [completedDomainFilter, setCompletedDomainFilter] = useState('ALL')

    useEffect(() => {
        loadExams()
    }, [])

    const loadExams = async () => {
        setLoading(true)
        try {
            const response = await ApiClient.getAvailableExams()
            const normalized = (response.data as RawExamListItem[]).map((exam) => {
                const attemptsUsed = Number.isFinite(exam.userAttempts)
                    ? exam.userAttempts
                    : exam.userStatus
                        ? exam.userStatus.completedAttempts + (exam.userStatus.hasInProgressAttempt ? 1 : 0)
                        : 0
                const bestScore = exam.bestScore ?? exam.userStatus?.bestScore ?? null
                const hasPassed = exam.hasPassed ?? exam.userStatus?.hasPassed ?? false
                const questionCount = exam._count?.questions ?? exam.questionCount ?? exam.questionCount ?? 0

                return {
                    ...exam,
                    userAttempts: attemptsUsed,
                    bestScore,
                    hasPassed,
                    attemptResults: exam.attemptResults ?? [],
                    _count: exam._count ?? { questions: questionCount },
                } as ExamListItem
            })
            setExams(normalized)
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load exams')
        } finally {
            setLoading(false)
        }
    }

    const isDeadlineSoon = (deadline: string | Date | null | undefined) => {
        if (!deadline) return false
        const deadlineDate = new Date(deadline)
        const now = new Date()
        const daysLeft = Math.ceil((deadlineDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
        return daysLeft <= 3 && daysLeft > 0
    }

    const isDeadlinePassed = (deadline: string | Date | null | undefined) => {
        if (!deadline) return false
        return new Date(deadline) < new Date()
    }

    const isNotYetAvailable = (availableFrom: string | Date | null | undefined) => {
        if (!availableFrom) return false
        return new Date(availableFrom) > new Date()
    }

    const isActiveExam = (exam: ExamListItem) => {
        return exam.status === 'PUBLISHED' && !isDeadlinePassed(exam.deadline) && !isNotYetAvailable(exam.availableFrom)
    }

    const isDueWithinDays = (deadline: string | Date | null | undefined, days: number) => {
        if (!deadline) return false
        const deadlineDate = new Date(deadline)
        const now = new Date()
        const daysLeft = Math.ceil((deadlineDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
        return daysLeft >= 0 && daysLeft <= days
    }

    const isCreatedWithinCustomRange = (createdAt: string | Date | null | undefined) => {
        if (!createdAt) return false
        const createdDate = new Date(createdAt)
        const from = createdFromFilter ? new Date(`${createdFromFilter}T00:00:00`) : null
        const to = createdToFilter ? new Date(`${createdToFilter}T23:59:59.999`) : null

        if (from && createdDate < from) return false
        if (to && createdDate > to) return false
        return true
    }

    const dateFilterLabel: Record<DateFilter, string> = {
        ACTIVE: 'Active exams',
        ALL: 'All dates',
        UPCOMING: 'Not yet available',
        DUE_7_DAYS: 'Due in 7 days',
        EXPIRED: 'Expired',
        NO_DEADLINE: 'No deadline',
        CUSTOM_CREATED: 'Created range',
    }

    const applyDateFilter = (value: DateFilter) => {
        setDateFilter(value)
        if (value !== 'CUSTOM_CREATED') {
            setDateMenuOpen(false)
        }
    }

    const getExamLabels = (exam: ExamListItem) => {
        const labels = new Set<string>()
        if (exam.assessmentKind) labels.add(exam.assessmentKind)
        if (exam.hasPassed) labels.add('Passed')
        if (isActiveExam(exam)) labels.add('Active')
        if (isDeadlineSoon(exam.deadline) && !exam.hasPassed) labels.add('Deadline Soon')
        if (isDeadlinePassed(exam.deadline)) labels.add('Expired')
        if (isNotYetAvailable(exam.availableFrom)) labels.add('Upcoming')
        if (exam.certificateEligible) labels.add('Certificate on pass')
        if (exam.countsTowardPerformance) labels.add('Performance')
        if (exam.awardsStars && exam.starValue) labels.add('Awards Stars')
        if (exam.course) labels.add('Course linked')
        return Array.from(labels)
    }

    const formatAttemptSubmittedAt = (date: string | Date | null | undefined) => {
        if (!date) return 'Pending grading'
        return new Date(date).toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
        })
    }

    const toggleExpanded = (examId: string) => {
        setExpandedExamIds((prev) =>
            prev.includes(examId) ? prev.filter((id) => id !== examId) : [...prev, examId]
        )
    }

    const labelSet = new Set<string>()
    exams.forEach((exam) => getExamLabels(exam).forEach((label) => labelSet.add(label)))
    const labelOptions = Array.from(labelSet).sort((a, b) => a.localeCompare(b))

    const domainMap = new Map<string, string>()
    exams.forEach((exam) => {
        if (exam.productDomain?.id) {
            domainMap.set(exam.productDomain.id, exam.productDomain.name)
        }
    })
    const domainOptions = Array.from(domainMap, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))

    const query = keywordFilter.trim().toLowerCase()
    const filteredExams = exams.filter((exam) => {
        if (dateFilter === 'ACTIVE' && !isActiveExam(exam)) return false
        if (dateFilter === 'UPCOMING' && !isNotYetAvailable(exam.availableFrom)) return false
        if (dateFilter === 'DUE_7_DAYS' && !isDueWithinDays(exam.deadline, 7)) return false
        if (dateFilter === 'EXPIRED' && !isDeadlinePassed(exam.deadline)) return false
        if (dateFilter === 'NO_DEADLINE' && exam.deadline) return false
        if (dateFilter === 'CUSTOM_CREATED' && !isCreatedWithinCustomRange(exam.createdAt)) return false

        if (domainFilter !== 'ALL' && exam.productDomain?.id !== domainFilter) return false

        const labels = getExamLabels(exam)
        if (labelFilter !== 'ALL' && !labels.includes(labelFilter)) return false

        if (!query) return true

        const searchable = [
            exam.title,
            exam.description,
            exam.assessmentKind,
            exam.course?.title,
            exam.productDomain?.name,
            ...labels,
        ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()

        return searchable.includes(query)
    })

    const assignedTotalPages = Math.max(1, Math.ceil(filteredExams.length / EXAMS_PER_PAGE))
    const paginatedAssignedExams = filteredExams.slice(
        (assignedPage - 1) * EXAMS_PER_PAGE,
        assignedPage * EXAMS_PER_PAGE,
    )

    const completedExams = exams.filter((exam) => (exam.attemptResults?.length ?? 0) > 0)
    const completedQuery = completedKeywordFilter.trim().toLowerCase()
    const filteredCompletedExams = completedExams.filter((exam) => {
        const latestAttempt = exam.attemptResults?.[0]
        if (completedResultFilter === 'PASSED' && !exam.hasPassed) return false
        if (completedResultFilter === 'NOT_PASSED' && (exam.hasPassed || latestAttempt?.passed !== false)) return false
        if (completedResultFilter === 'PENDING' && latestAttempt?.passed !== null) return false
        if (completedDomainFilter !== 'ALL' && exam.productDomain?.id !== completedDomainFilter) return false
        if (!completedQuery) return true

        return [exam.title, exam.description, exam.course?.title, exam.productDomain?.name]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
            .includes(completedQuery)
    })
    const completedTotalPages = Math.max(1, Math.ceil(filteredCompletedExams.length / EXAMS_PER_PAGE))
    const paginatedCompletedExams = filteredCompletedExams.slice(
        (completedPage - 1) * EXAMS_PER_PAGE,
        completedPage * EXAMS_PER_PAGE,
    )

    useEffect(() => {
        setAssignedPage(1)
    }, [keywordFilter, labelFilter, domainFilter, dateFilter, createdFromFilter, createdToFilter])

    useEffect(() => {
        setCompletedPage(1)
    }, [completedKeywordFilter, completedResultFilter, completedDomainFilter])

    useEffect(() => {
        if (assignedPage > assignedTotalPages) setAssignedPage(assignedTotalPages)
    }, [assignedPage, assignedTotalPages])

    useEffect(() => {
        if (completedPage > completedTotalPages) setCompletedPage(completedTotalPages)
    }, [completedPage, completedTotalPages])

    if (loading) {
        return (
            <DashboardLayout>
                <div className="flex items-center justify-center py-12">
                    <Loader2 className="h-8 w-8 animate-spin text-primary" />
                </div>
            </DashboardLayout>
        )
    }

    const availableExams = exams.filter(e => isActiveExam(e))
    const passedCount = exams.filter(e => e.hasPassed).length
    const totalAttempts = exams.reduce((sum, e) => sum + (e.userAttempts ?? 0), 0)
    const expiredCount = exams.filter(e => isDeadlinePassed(e.deadline)).length
    const hasActiveFilters =
        keywordFilter.trim() ||
        labelFilter !== 'ALL' ||
        domainFilter !== 'ALL' ||
        dateFilter !== 'ALL' ||
        createdFromFilter ||
        createdToFilter

    return (
        <DashboardLayout>
            <div className="space-y-5">
                <div className="flex flex-col gap-4 border-b border-slate-200/70 pb-5 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                        <Badge variant="secondary" className="mb-3 w-fit">Assessment Workspace</Badge>
                        <h1 className="text-2xl font-semibold tracking-[-0.03em] md:text-3xl">My exams</h1>
                    </div>

                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:min-w-[560px]">
                        <div className="rounded-lg border border-slate-200/70 bg-white px-3 py-2">
                            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                                <FileQuestion className="h-3.5 w-3.5 text-primary" />
                                Available
                            </div>
                            <div className="mt-1 text-xl font-semibold tracking-[-0.03em]">{availableExams.length}</div>
                        </div>
                        <div className="rounded-lg border border-slate-200/70 bg-white px-3 py-2">
                            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                                <Trophy className="h-3.5 w-3.5 text-primary" />
                                Passed
                            </div>
                            <div className="mt-1 text-xl font-semibold tracking-[-0.03em] text-emerald-700">{passedCount}</div>
                        </div>
                        <div className="rounded-lg border border-slate-200/70 bg-white px-3 py-2">
                            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                                <Play className="h-3.5 w-3.5 text-primary" />
                                Attempts
                            </div>
                            <div className="mt-1 text-xl font-semibold tracking-[-0.03em]">{totalAttempts}</div>
                        </div>
                        <div className="rounded-lg border border-slate-200/70 bg-white px-3 py-2">
                            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                                <Clock className="h-3.5 w-3.5 text-primary" />
                                Expired
                            </div>
                            <div className="mt-1 text-xl font-semibold tracking-[-0.03em]">{expiredCount}</div>
                        </div>
                    </div>
                </div>

                {error && (
                    <div className="flex items-center gap-2 rounded-2xl border border-destructive/15 bg-destructive/5 p-4 text-destructive">
                        <XCircle className="h-4 w-4" />
                        {error}
                    </div>
                )}

                <Card>
                    <CardHeader className="space-y-4">
                        <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
                            <div>
                                <CardTitle>Assigned exams</CardTitle>
                                <CardDescription>
                                    Showing {filteredExams.length} of {exams.length} assigned exams.
                                </CardDescription>
                            </div>
                            {hasActiveFilters ? (
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() => {
                                        setKeywordFilter('')
                                        setLabelFilter('ALL')
                                        setDomainFilter('ALL')
                                        setDateFilter('ALL')
                                        setCreatedFromFilter('')
                                        setCreatedToFilter('')
                                    }}
                                >
                                    Clear filters
                                </Button>
                            ) : null}
                        </div>

                        <div className="grid gap-3 rounded-lg border border-slate-200/70 bg-slate-50/70 p-3 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
                            <div className="relative">
                                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                                <Input
                                    value={keywordFilter}
                                    onChange={(e) => setKeywordFilter(e.target.value)}
                                    placeholder="Search title, course, domain..."
                                    className="bg-white pl-9"
                                />
                            </div>
                            <Select value={labelFilter} onValueChange={setLabelFilter}>
                                <SelectTrigger className="bg-white">
                                    <div className="flex items-center gap-2">
                                        <Filter className="h-4 w-4 text-muted-foreground" />
                                        <SelectValue placeholder="Label" />
                                    </div>
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="ALL">All labels</SelectItem>
                                    {labelOptions.map((label) => (
                                        <SelectItem key={label} value={label}>
                                            {label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <Select value={domainFilter} onValueChange={setDomainFilter}>
                                <SelectTrigger className="bg-white">
                                    <SelectValue placeholder="Domain" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="ALL">All domains</SelectItem>
                                    {domainOptions.map((domain) => (
                                        <SelectItem key={domain.id} value={domain.id}>
                                            {domain.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <div className="relative">
                                <button
                                    type="button"
                                    className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-white px-3 py-2 text-sm ring-offset-background transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                                    onClick={() => setDateMenuOpen((open) => !open)}
                                >
                                    <span>{dateFilterLabel[dateFilter]}</span>
                                    <ChevronDown className="h-4 w-4 opacity-50" />
                                </button>
                                {dateMenuOpen ? (
                                    <div className="absolute right-0 z-50 mt-2 w-[min(360px,calc(100vw-3rem))] rounded-lg border border-slate-200 bg-white p-2 shadow-xl shadow-slate-900/10">
                                        <div className="grid gap-1">
                                            {(['ACTIVE', 'ALL', 'UPCOMING', 'DUE_7_DAYS', 'EXPIRED', 'NO_DEADLINE'] as DateFilter[]).map((value) => (
                                                <button
                                                    key={value}
                                                    type="button"
                                                    className={`rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-slate-100 ${dateFilter === value ? 'bg-slate-100 font-medium text-[#006688]' : ''}`}
                                                    onClick={() => applyDateFilter(value)}
                                                >
                                                    {dateFilterLabel[value]}
                                                </button>
                                            ))}
                                        </div>

                                        <div className="mt-2 border-t border-slate-200 pt-3">
                                            <button
                                                type="button"
                                                className={`mb-3 w-full rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-slate-100 ${dateFilter === 'CUSTOM_CREATED' ? 'bg-slate-100 font-medium text-[#006688]' : ''}`}
                                                onClick={() => applyDateFilter('CUSTOM_CREATED')}
                                            >
                                                Created range
                                            </button>
                                            <div className="grid gap-3 sm:grid-cols-2">
                                                <div className="space-y-1">
                                                    <label className="text-xs font-medium text-muted-foreground" htmlFor="createdFrom">
                                                        Created from
                                                    </label>
                                                    <Input
                                                        id="createdFrom"
                                                        type="date"
                                                        value={createdFromFilter}
                                                        onChange={(e) => {
                                                            setDateFilter('CUSTOM_CREATED')
                                                            setCreatedFromFilter(e.target.value)
                                                        }}
                                                    />
                                                </div>
                                                <div className="space-y-1">
                                                    <label className="text-xs font-medium text-muted-foreground" htmlFor="createdTo">
                                                        Created to
                                                    </label>
                                                    <Input
                                                        id="createdTo"
                                                        type="date"
                                                        value={createdToFilter}
                                                        onChange={(e) => {
                                                            setDateFilter('CUSTOM_CREATED')
                                                            setCreatedToFilter(e.target.value)
                                                        }}
                                                    />
                                                </div>
                                            </div>
                                            <div className="mt-3 flex justify-end gap-2">
                                                <Button
                                                    type="button"
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={() => {
                                                        setCreatedFromFilter('')
                                                        setCreatedToFilter('')
                                                        setDateFilter('ALL')
                                                        setDateMenuOpen(false)
                                                    }}
                                                >
                                                    Reset
                                                </Button>
                                                <Button type="button" size="sm" onClick={() => setDateMenuOpen(false)}>
                                                    Apply
                                                </Button>
                                            </div>
                                        </div>
                                    </div>
                                ) : null}
                                {dateMenuOpen ? (
                                    <button
                                        type="button"
                                        className="fixed inset-0 z-40 cursor-default"
                                        aria-label="Close date filter"
                                        tabIndex={-1}
                                        onClick={() => setDateMenuOpen(false)}
                                    />
                                ) : null}
                            </div>
                        </div>
                    </CardHeader>
                    <CardContent>
                        {exams.length === 0 ? (
                            <div className="py-12 text-center">
                                <FileQuestion className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                                <p className="text-muted-foreground">No exams available at this time</p>
                            </div>
                        ) : (
                            <div className="space-y-4">
                                {filteredExams.length === 0 ? (
                                    <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/70 py-10 text-center">
                                        <FileQuestion className="mx-auto mb-3 h-9 w-9 text-muted-foreground" />
                                        <p className="text-sm text-muted-foreground">No exams match the current filters.</p>
                                    </div>
                                ) : null}
                                {paginatedAssignedExams.map(exam => (
                                    <div
                                        key={exam.id}
                                        className="rounded-[1.35rem] border border-slate-200/70 bg-white p-4 transition-all duration-200 hover:border-[#00c2ff]/10 hover:shadow-lg hover:shadow-[#006688]/5"
                                    >
                                        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                                            <div className="min-w-0 flex-1 space-y-3">
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <h3 className="text-lg font-semibold tracking-[-0.03em]">{exam.title}</h3>
                                                    {exam.assessmentKind ? <Badge variant="outline">{exam.assessmentKind}</Badge> : null}
                                                    {exam.hasPassed ? (
                                                        <Badge className="border-emerald-200 bg-emerald-100 text-emerald-800 dark:bg-green-900/20 dark:text-green-200">
                                                            <CheckCircle className="mr-1 h-3 w-3" />
                                                            Passed
                                                        </Badge>
                                                    ) : null}
                                                    {isDeadlineSoon(exam.deadline) && !exam.hasPassed ? (
                                                        <Badge variant="destructive">
                                                            <AlertCircle className="mr-1 h-3 w-3" />
                                                            Deadline Soon
                                                        </Badge>
                                                    ) : null}
                                                    {isDeadlinePassed(exam.deadline) ? <Badge variant="outline">Expired</Badge> : null}
                                                    {exam.status === 'CLOSED' ? <Badge variant="outline">Closed</Badge> : null}
                                                    {exam.status === 'ARCHIVED' ? <Badge variant="outline">Archived</Badge> : null}
                                                    {exam.certificateEligible ? <Badge variant="outline">Certificate on pass</Badge> : null}
                                                    {exam.countsTowardPerformance ? <Badge>Performance</Badge> : null}
                                                </div>

                                                <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
                                                    <span className="flex items-center gap-1">
                                                        <FileQuestion className="h-4 w-4" />
                                                        {exam._count?.questions ?? 0} questions
                                                    </span>
                                                    {exam.timeLimit ? (
                                                        <span className="flex items-center gap-1">
                                                            <Clock className="h-4 w-4" />
                                                            {exam.timeLimit} min
                                                        </span>
                                                    ) : null}
                                                    <span>Pass {exam.passingScore}/{exam.totalScore}</span>
                                                    <span>Attempts {(exam.userAttempts ?? 0)}/{exam.maxAttempts}</span>
                                                    {exam.deadline ? (
                                                        <span className="flex items-center gap-1">
                                                            <Calendar className="h-4 w-4" />
                                                            {buildExamScheduleDisplay(exam.deadline, exam.timezone)?.localLabel}
                                                        </span>
                                                    ) : null}
                                                    {exam.bestScore !== null ? (
                                                        <span className="font-medium text-slate-700">Best {exam.bestScore}%</span>
                                                    ) : null}
                                                </div>

                                                {exam.course || exam.productDomain || (exam.awardsStars && exam.starValue) ? (
                                                    <div className="flex flex-wrap gap-2">
                                                        {exam.productDomain ? (
                                                            <Badge variant="secondary" className="text-xs">
                                                                Domain: {exam.productDomain.name}
                                                            </Badge>
                                                        ) : null}
                                                        {exam.course ? (
                                                            <Badge variant="secondary" className="text-xs">
                                                                Course: {exam.course.title}
                                                            </Badge>
                                                        ) : null}
                                                        {exam.awardsStars && exam.starValue ? (
                                                            <Badge variant="secondary" className="text-xs">
                                                                +{exam.starValue} stars
                                                            </Badge>
                                                        ) : null}
                                                    </div>
                                                ) : null}
                                            </div>

                                            <div className="flex flex-col gap-2 sm:flex-row lg:flex-col lg:items-end">
                                                {exam.status !== 'PUBLISHED' ? (
                                                    exam.attemptResults?.[0] ? (
                                                        <Link href={`/exams/${exam.id}/result?attemptId=${exam.attemptResults[0].id}`}>
                                                            <Button variant="outline" className="w-full sm:w-auto">
                                                                View Results
                                                            </Button>
                                                        </Link>
                                                    ) : (
                                                        <Button variant="outline" className="w-full sm:w-auto" disabled>
                                                            Exam Closed
                                                        </Button>
                                                    )
                                                ) : (
                                                    <Link href={`/exams/${exam.id}`}>
                                                        <Button
                                                            className="w-full sm:w-auto"
                                                            disabled={isDeadlinePassed(exam.deadline) || ((exam.userAttempts ?? 0) >= exam.maxAttempts && !exam.hasPassed)}
                                                        >
                                                            {isDeadlinePassed(exam.deadline) ? (
                                                                'Deadline Passed'
                                                            ) : (exam.userAttempts ?? 0) === 0 ? (
                                                                <>
                                                                    <Play className="mr-2 h-4 w-4" />
                                                                    Start Exam
                                                                </>
                                                            ) : (exam.userAttempts ?? 0) >= exam.maxAttempts ? (
                                                                'View Results'
                                                            ) : (
                                                                <>
                                                                    <Play className="mr-2 h-4 w-4" />
                                                                    Retry
                                                                </>
                                                            )}
                                                        </Button>
                                                    </Link>
                                                )}
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    className="w-full justify-between px-3 sm:w-auto"
                                                    onClick={() => toggleExpanded(exam.id)}
                                                >
                                                    <span>{expandedExamIds.includes(exam.id) ? 'Hide details' : 'Show details'}</span>
                                                    {expandedExamIds.includes(exam.id) ? (
                                                        <ChevronUp className="ml-2 h-4 w-4" />
                                                    ) : (
                                                        <ChevronDown className="ml-2 h-4 w-4" />
                                                    )}
                                                </Button>
                                            </div>
                                        </div>

                                        {expandedExamIds.includes(exam.id) ? (
                                            <div className="mt-4 border-t border-slate-200/70 pt-4">
                                                {exam.description ? (
                                                    <p className="mb-4 text-sm leading-6 text-muted-foreground">
                                                        {exam.description}
                                                    </p>
                                                ) : null}

                                                {exam.bestScore !== null ? (
                                                    <div className="mb-4">
                                                        <div className="mb-2 flex items-center justify-between text-sm">
                                                            <span>Best Score</span>
                                                            <span className="font-medium">{exam.bestScore}%</span>
                                                        </div>
                                                        <Progress
                                                            value={exam.bestScore}
                                                            className={exam.hasPassed ? '[&>div]:bg-green-500' : ''}
                                                        />
                                                    </div>
                                                ) : null}

                                                {(exam.awardsStars && exam.starValue) || exam.certificateEligible ? (
                                                    <div className="mb-4 flex flex-wrap gap-2 text-xs text-muted-foreground">
                                                        {exam.awardsStars && exam.starValue ? (
                                                            <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1">
                                                                Passing awards {exam.starValue} star{exam.starValue === 1 ? '' : 's'} and contributes to badge progression.
                                                            </span>
                                                        ) : null}
                                                        {exam.certificateEligible ? (
                                                            <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1">
                                                                Passing can issue a formal certificate.
                                                            </span>
                                                        ) : null}
                                                    </div>
                                                ) : null}

                                                {exam.attemptResults && exam.attemptResults.length > 0 ? (
                                                    <div className="rounded-2xl border border-slate-200/70 bg-slate-50 p-4">
                                                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                                                            Attempt Results
                                                        </p>
                                                        <div className="mt-3 space-y-2">
                                                            {exam.attemptResults.map((attempt) => (
                                                                <div
                                                                    key={attempt.id}
                                                                    className="flex flex-col gap-2 rounded-2xl border border-border/70 bg-white/80 px-4 py-3 md:flex-row md:items-center md:justify-between"
                                                                >
                                                                    <div className="flex flex-wrap items-center gap-2 text-sm">
                                                                        <span className="font-medium">
                                                                            Attempt #{attempt.attemptNumber}
                                                                        </span>
                                                                        {attempt.passed === true ? (
                                                                            <Badge className="bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-200">
                                                                                Passed
                                                                            </Badge>
                                                                        ) : attempt.passed === false ? (
                                                                            <Badge variant="secondary">
                                                                                Not Passed
                                                                            </Badge>
                                                                        ) : (
                                                                            <Badge variant="outline">
                                                                                {attempt.status === 'GRADED' ? 'Graded' : 'Submitted'}
                                                                            </Badge>
                                                                        )}
                                                                        {attempt.percentageScore !== null ? (
                                                                            <span className="text-muted-foreground">
                                                                                Score: {attempt.percentageScore}%
                                                                            </span>
                                                                        ) : null}
                                                                        <span className="text-muted-foreground">
                                                                            Submitted: {formatAttemptSubmittedAt(attempt.submittedAt)}
                                                                        </span>
                                                                    </div>
                                                                    <Link href={`/exams/${exam.id}/result?attemptId=${attempt.id}`}>
                                                                        <Button variant="outline" size="sm">
                                                                            <Eye className="mr-2 h-4 w-4" />
                                                                            Answer Review
                                                                        </Button>
                                                                    </Link>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    </div>
                                                ) : null}
                                            </div>
                                        ) : null}
                                    </div>
                                ))}
                                <ExamPagination
                                    page={assignedPage}
                                    totalPages={assignedTotalPages}
                                    totalItems={filteredExams.length}
                                    onPageChange={setAssignedPage}
                                />
                            </div>
                        )}
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="space-y-4">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                            <div>
                                <CardTitle className="flex items-center gap-2">
                                    <Trophy className="h-5 w-5 text-primary" />
                                    Completed exams
                                </CardTitle>
                                <CardDescription>
                                    Showing {filteredCompletedExams.length} of {completedExams.length} submitted assessments.
                                </CardDescription>
                            </div>
                            {completedKeywordFilter || completedResultFilter !== 'ALL' || completedDomainFilter !== 'ALL' ? (
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() => {
                                        setCompletedKeywordFilter('')
                                        setCompletedResultFilter('ALL')
                                        setCompletedDomainFilter('ALL')
                                    }}
                                >
                                    Clear filters
                                </Button>
                            ) : null}
                        </div>

                        <div className="grid gap-3 rounded-lg border border-slate-200/70 bg-slate-50/70 p-3 md:grid-cols-[1.4fr_1fr_1fr]">
                            <div className="relative">
                                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                                <Input
                                    value={completedKeywordFilter}
                                    onChange={(event) => setCompletedKeywordFilter(event.target.value)}
                                    placeholder="Search title, course, domain..."
                                    className="bg-white pl-9"
                                />
                            </div>
                            <Select value={completedResultFilter} onValueChange={(value) => setCompletedResultFilter(value as CompletedResultFilter)}>
                                <SelectTrigger className="bg-white">
                                    <SelectValue placeholder="Result" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="ALL">All results</SelectItem>
                                    <SelectItem value="PASSED">Passed</SelectItem>
                                    <SelectItem value="NOT_PASSED">Not passed</SelectItem>
                                    <SelectItem value="PENDING">Pending grading</SelectItem>
                                </SelectContent>
                            </Select>
                            <Select value={completedDomainFilter} onValueChange={setCompletedDomainFilter}>
                                <SelectTrigger className="bg-white">
                                    <SelectValue placeholder="Domain" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="ALL">All domains</SelectItem>
                                    {domainOptions.map((domain) => (
                                        <SelectItem key={domain.id} value={domain.id}>
                                            {domain.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    </CardHeader>
                    <CardContent>
                        {paginatedCompletedExams.length === 0 ? (
                            <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/70 py-10 text-center">
                                <CheckCircle className="mx-auto mb-3 h-9 w-9 text-muted-foreground" />
                                <p className="text-sm text-muted-foreground">No completed exams match the current filters.</p>
                            </div>
                        ) : (
                            <div className="space-y-3">
                                {paginatedCompletedExams.map((exam) => {
                                    const latestAttempt = exam.attemptResults![0]
                                    const resultLabel = exam.hasPassed
                                        ? 'Passed'
                                        : latestAttempt.passed === false
                                            ? 'Not passed'
                                            : 'Pending grading'

                                    return (
                                        <div
                                            key={exam.id}
                                            className="flex flex-col gap-4 rounded-lg border border-slate-200/70 bg-white p-4 sm:flex-row sm:items-center sm:justify-between"
                                        >
                                            <div className="flex min-w-0 items-start gap-3">
                                                {exam.hasPassed ? (
                                                    <CheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
                                                ) : (
                                                    <Clock className="mt-0.5 h-5 w-5 shrink-0 text-slate-500" />
                                                )}
                                                <div className="min-w-0">
                                                    <p className="font-medium">{exam.title}</p>
                                                    <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                                                        <Badge variant={exam.hasPassed ? 'default' : 'secondary'}>{resultLabel}</Badge>
                                                        {latestAttempt.percentageScore !== null ? (
                                                            <span>Score: {latestAttempt.percentageScore}%</span>
                                                        ) : null}
                                                        <span>{formatAttemptSubmittedAt(latestAttempt.submittedAt)}</span>
                                                    </div>
                                                    <div className="mt-2 flex flex-wrap gap-2">
                                                        {exam.productDomain ? <Badge variant="outline">{exam.productDomain.name}</Badge> : null}
                                                        {exam.course ? <Badge variant="secondary">{exam.course.title}</Badge> : null}
                                                        {exam.awardsStars && exam.starValue ? (
                                                            <Badge variant="secondary">+{exam.starValue} stars</Badge>
                                                        ) : null}
                                                    </div>
                                                </div>
                                            </div>
                                            <Link href={`/exams/${exam.id}/result?attemptId=${latestAttempt.id}`}>
                                                <Button variant="outline" size="sm" className="w-full sm:w-auto">
                                                    <Eye className="mr-2 h-4 w-4" />
                                                    View Results
                                                </Button>
                                            </Link>
                                        </div>
                                    )
                                })}
                                <ExamPagination
                                    page={completedPage}
                                    totalPages={completedTotalPages}
                                    totalItems={filteredCompletedExams.length}
                                    onPageChange={setCompletedPage}
                                />
                            </div>
                        )}
                    </CardContent>
                </Card>
            </div>
        </DashboardLayout>
    )
}

function ExamPagination({
    page,
    totalPages,
    totalItems,
    onPageChange,
}: {
    page: number
    totalPages: number
    totalItems: number
    onPageChange: (page: number) => void
}) {
    if (totalItems <= EXAMS_PER_PAGE) return null

    const firstItem = (page - 1) * EXAMS_PER_PAGE + 1
    const lastItem = Math.min(page * EXAMS_PER_PAGE, totalItems)

    return (
        <div className="flex flex-col gap-3 border-t border-slate-200/70 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">
                Showing {firstItem}-{lastItem} of {totalItems} · Page {page} of {totalPages}
            </p>
            <div className="flex items-center gap-2">
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => onPageChange(page - 1)}
                >
                    <ChevronLeft className="mr-1 h-4 w-4" />
                    Previous
                </Button>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={page >= totalPages}
                    onClick={() => onPageChange(page + 1)}
                >
                    Next
                    <ChevronRight className="ml-1 h-4 w-4" />
                </Button>
            </div>
        </div>
    )
}
