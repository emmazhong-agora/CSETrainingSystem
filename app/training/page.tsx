'use client'

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import {
    ResponsiveContainer,
    LineChart,
    Line,
    CartesianGrid,
    XAxis,
    Tooltip as RechartsTooltip,
    YAxis,
} from 'recharts'
import { DashboardLayout } from '@/components/layout/dashboard-layout'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { ApiClient } from '@/lib/api-client'
import type { LearnerTrainingOverview, UserProgressOverview } from '@/types'
import { formatDate } from '@/lib/utils'
import {
    BookOpen,
    CalendarClock,
    CalendarDays,
    CheckCircle2,
    ChevronLeft,
    ChevronRight,
    Clock,
    Loader2,
    Play,
    RefreshCcw,
    TrendingUp,
} from 'lucide-react'

type TrainingDrilldown = 'all-courses' | 'in-progress' | 'pending-assessments' | 'passed-assessments'

const isTrainingDrilldown = (value: string | null): value is TrainingDrilldown =>
    value === 'all-courses' ||
    value === 'in-progress' ||
    value === 'pending-assessments' ||
    value === 'passed-assessments'

const PAGE_SIZE = 5

export default function TrainingPage() {
    return (
        <Suspense fallback={<TrainingPageFallback />}>
            <TrainingPageContent />
        </Suspense>
    )
}

function TrainingPageFallback() {
    return (
        <DashboardLayout>
            <div className="flex min-h-[50vh] items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
        </DashboardLayout>
    )
}

function TrainingPageContent() {
    const searchParams = useSearchParams()
    const [trainingOverview, setTrainingOverview] = useState<LearnerTrainingOverview | null>(null)
    const [progressOverview, setProgressOverview] = useState<UserProgressOverview | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [refreshIndex, setRefreshIndex] = useState(0)
    const [dateFrom, setDateFrom] = useState('')
    const [dateTo, setDateTo] = useState('')
    const [coursePage, setCoursePage] = useState(1)
    const [assessmentPage, setAssessmentPage] = useState(1)
    const [eventPage, setEventPage] = useState(1)
    const [targetPage, setTargetPage] = useState(1)
    const requestedDrilldown = searchParams.get('view')
    const drilldown = isTrainingDrilldown(requestedDrilldown) ? requestedDrilldown : null

    const dateBounds = useMemo(() => ({
        from: dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : null,
        to: dateTo ? new Date(`${dateTo}T23:59:59.999`).getTime() : null,
    }), [dateFrom, dateTo])

    const isWithinDateRange = useCallback((value: string | Date | null | undefined) => {
        if (!dateBounds.from && !dateBounds.to) return true
        if (!value) return false
        const timestamp = new Date(value).getTime()
        if (!Number.isFinite(timestamp)) return false
        if (dateBounds.from && timestamp < dateBounds.from) return false
        if (dateBounds.to && timestamp > dateBounds.to) return false
        return true
    }, [dateBounds])

    useEffect(() => {
        setCoursePage(1)
        setAssessmentPage(1)
        setEventPage(1)
        setTargetPage(1)
    }, [dateFrom, dateTo, drilldown])

    useEffect(() => {
        let cancelled = false

        const load = async () => {
            setLoading(true)
            setError(null)

            const [trainingRes, progressRes] = await Promise.allSettled([
                ApiClient.getLearnerTrainingOverview(),
                ApiClient.getProgressOverview(),
            ])

            if (cancelled) return

            if (trainingRes.status === 'fulfilled') {
                setTrainingOverview(trainingRes.value.data)
            } else {
                setTrainingOverview(null)
            }

            if (progressRes.status === 'fulfilled') {
                setProgressOverview(progressRes.value.data)
            } else {
                setProgressOverview(null)
            }

            if (trainingRes.status === 'rejected' && progressRes.status === 'rejected') {
                setError('Failed to load learning overview')
            } else if (trainingRes.status === 'rejected' || progressRes.status === 'rejected') {
                setError('Some learning data could not be loaded')
            }

            setLoading(false)
        }

        void load()

        return () => {
            cancelled = true
        }
    }, [refreshIndex])

    const filteredCourses = useMemo(
        () => progressOverview?.courses.filter((course) =>
            isWithinDateRange(course.lastAccessedAt ?? course.enrolledAt)
        ) ?? [],
        [isWithinDateRange, progressOverview]
    )

    const filteredAssignedExams = useMemo(
        () => trainingOverview?.assignedExams.filter((exam) =>
            isWithinDateRange(exam.latestSubmittedAt ?? exam.invitationViewedAt ?? exam.invitationCreatedAt)
        ) ?? [],
        [isWithinDateRange, trainingOverview]
    )

    const filteredEvents = useMemo(
        () => trainingOverview?.upcomingEvents.filter((event) =>
            isWithinDateRange(event.scheduledAt ?? event.createdAt)
        ) ?? [],
        [isWithinDateRange, trainingOverview]
    )

    const filteredRecentCompletions = useMemo(
        () => trainingOverview?.recentCompletions.filter((attempt) =>
            isWithinDateRange(attempt.submittedAt ?? attempt.startedAt)
        ) ?? [],
        [isWithinDateRange, trainingOverview]
    )

    const filteredActivity = useMemo(
        () => progressOverview?.recentActivity.filter((entry) => isWithinDateRange(entry.updatedAt)) ?? [],
        [isWithinDateRange, progressOverview]
    )

    const filteredTargets = useMemo(
        () => progressOverview?.upcomingDeadlines.filter((target) => isWithinDateRange(target.deadline)) ?? [],
        [isWithinDateRange, progressOverview]
    )

    const activityChartData = useMemo(() => {
        return [...filteredActivity]
            .sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime())
            .map((entry) => ({
                date: formatDate(entry.updatedAt),
                minutes: Math.round(entry.watchedDuration / 60),
            }))
    }, [filteredActivity])

    const handleRefresh = () => setRefreshIndex((prev) => prev + 1)

    const visibleCourses = useMemo(
        () => filteredCourses.filter((course) => drilldown !== 'in-progress' || course.status !== 'COMPLETED'),
        [drilldown, filteredCourses]
    )

    const visibleAssignedExams = useMemo(
        () => filteredAssignedExams.filter((exam) =>
            drilldown !== 'pending-assessments' || (!exam.userStatus.hasPassed && exam.userStatus.remainingAttempts > 0)
        ),
        [drilldown, filteredAssignedExams]
    )

    const visibleRecentCompletions = useMemo(
        () => filteredRecentCompletions.filter((attempt) => drilldown !== 'passed-assessments' || attempt.passed),
        [drilldown, filteredRecentCompletions]
    )

    const pagedCourses = visibleCourses.slice((coursePage - 1) * PAGE_SIZE, coursePage * PAGE_SIZE)
    const pagedAssessments = visibleAssignedExams.slice((assessmentPage - 1) * PAGE_SIZE, assessmentPage * PAGE_SIZE)
    const pagedEvents = filteredEvents.slice((eventPage - 1) * PAGE_SIZE, eventPage * PAGE_SIZE)
    const pagedTargets = filteredTargets.slice((targetPage - 1) * PAGE_SIZE, targetPage * PAGE_SIZE)

    const pendingAssessmentCount = filteredAssignedExams.filter(
        (exam) => !exam.userStatus.hasPassed && exam.userStatus.remainingAttempts > 0
    ).length
    const passedAssessmentCount = filteredAssignedExams.filter((exam) => exam.userStatus.hasPassed).length
    const inProgressCourseCount = filteredCourses.filter((course) => course.status !== 'COMPLETED').length

    return (
        <DashboardLayout>
            <div className="space-y-6">
                <div className="flex flex-wrap items-center justify-between gap-4">
                    <div>
                        <h1 className="text-3xl font-bold">My Learning</h1>
                        <p className="mt-1 text-muted-foreground">
                            Keep course progress, assigned assessments, upcoming sessions, and recent completions in one place.
                        </p>
                    </div>
                    <div className="flex gap-3">
                        <Button variant="outline" onClick={handleRefresh} disabled={loading}>
                            <RefreshCcw className="mr-2 h-4 w-4" />
                            Refresh
                        </Button>
                        <Link href="/exams">
                            <Button variant="outline">My Exams</Button>
                        </Link>
                        <Link href="/rewards">
                            <Button variant="outline">My Rewards</Button>
                        </Link>
                    </div>
                </div>

                {loading ? (
                    <div className="flex h-32 items-center justify-center text-muted-foreground">
                        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                        Loading learning...
                    </div>
                ) : !trainingOverview && !progressOverview ? (
                    <Card>
                        <CardContent className="py-10 text-center">
                            <p className="font-medium">{error || 'Failed to load learning overview'}</p>
                        </CardContent>
                    </Card>
                ) : (
                    <>
                        {error ? (
                            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                                {error}
                            </div>
                        ) : null}

                        <div className="flex flex-wrap items-end justify-between gap-4 border-y bg-muted/30 px-4 py-4">
                            <div className="flex flex-wrap items-end gap-3">
                                <div className="space-y-1.5">
                                    <label htmlFor="learning-date-from" className="text-xs font-medium text-muted-foreground">From</label>
                                    <input
                                        id="learning-date-from"
                                        type="date"
                                        value={dateFrom}
                                        max={dateTo || undefined}
                                        onChange={(event) => setDateFrom(event.target.value)}
                                        className="flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
                                    />
                                </div>
                                <div className="space-y-1.5">
                                    <label htmlFor="learning-date-to" className="text-xs font-medium text-muted-foreground">To</label>
                                    <input
                                        id="learning-date-to"
                                        type="date"
                                        value={dateTo}
                                        min={dateFrom || undefined}
                                        onChange={(event) => setDateTo(event.target.value)}
                                        className="flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
                                    />
                                </div>
                                {dateFrom || dateTo ? (
                                    <Button variant="ghost" onClick={() => { setDateFrom(''); setDateTo('') }}>
                                        Clear dates
                                    </Button>
                                ) : null}
                            </div>
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                <CalendarDays className="h-4 w-4" />
                                {dateFrom || dateTo ? 'Filtered by relevant activity date' : 'All dates'}
                            </div>
                        </div>

                        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
                            <SummaryCard href="/training?view=all-courses#continue-courses" title="Enrolled Courses" value={filteredCourses.length} helper="Courses in this date range" icon={BookOpen} />
                            <SummaryCard href="/training?view=in-progress#continue-courses" title="In Progress" value={inProgressCourseCount} helper="Not yet completed" icon={TrendingUp} />
                            <SummaryCard href="/training?view=pending-assessments#assigned-assessments" title="Pending Assessments" value={pendingAssessmentCount} helper="Still available to complete" icon={Clock} />
                            <SummaryCard href="/training?view=passed-assessments#recent-completions" title="Passed" value={passedAssessmentCount} helper="Passed in this date range" icon={CheckCircle2} />
                            <SummaryCard href="/training#upcoming-events" title="Upcoming Events" value={filteredEvents.length} helper="Events in this date range" icon={CalendarClock} />
                            <SummaryCard href="/training#study-activity" title="Learning Hours" value={Number((progressOverview?.stats.hoursLearned ?? 0).toFixed(1))} helper="All-time study time logged" icon={Clock} />
                        </div>

                        <div className="grid gap-6 xl:grid-cols-[1.1fr_1.4fr]">
                            <Card id="continue-courses" className="scroll-mt-24">
                                <CardHeader>
                                    <CardTitle>{drilldown === 'in-progress' ? 'Courses In Progress' : 'Continue Courses'}</CardTitle>
                                    <CardDescription>{drilldown === 'in-progress' ? 'Assigned courses that are not yet complete.' : 'Resume courses you are enrolled in.'}</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    {pagedCourses.length ? (
                                        pagedCourses.map((course) => (
                                            <div
                                                key={course.courseId}
                                                className="flex flex-col justify-between gap-4 rounded-lg border p-4 md:flex-row md:items-center"
                                            >
                                                <div>
                                                    <p className="font-semibold">{course.title}</p>
                                                    <p className="text-sm text-muted-foreground">
                                                        {course.instructorName} · {course.category} · {course.level}
                                                    </p>
                                                    <div className="mt-2 flex items-center gap-2">
                                                        <Badge variant={course.status === 'COMPLETED' ? 'default' : 'secondary'}>
                                                            {course.status === 'COMPLETED' ? 'Completed' : 'In progress'}
                                                        </Badge>
                                                        <span className="text-xs text-muted-foreground">
                                                            Last accessed {course.lastAccessedAt ? formatDate(course.lastAccessedAt) : 'N/A'}
                                                        </span>
                                                    </div>
                                                </div>
                                                <div className="w-full space-y-3 md:w-64">
                                                    <div className="mb-1 flex items-center justify-between text-sm">
                                                        <span>Progress</span>
                                                        <span className="font-medium">{course.progress}%</span>
                                                    </div>
                                                    <Progress value={course.progress} />
                                                    <Link href={`/courses/${course.slug}`}>
                                                        <Button variant="outline" size="sm" className="w-full">
                                                            Open course
                                                        </Button>
                                                    </Link>
                                                </div>
                                            </div>
                                        ))
                                    ) : (
                                        <p className="text-sm text-muted-foreground">You have not enrolled in any courses yet.</p>
                                    )}
                                    <PaginationControls
                                        page={coursePage}
                                        totalItems={visibleCourses.length}
                                        onPageChange={setCoursePage}
                                    />
                                </CardContent>
                            </Card>

                            <Card id="assigned-assessments" className="scroll-mt-24">
                                <CardHeader>
                                    <CardTitle>{drilldown === 'pending-assessments' ? 'Pending Assessments' : 'Assigned Assessments'}</CardTitle>
                                    <CardDescription>{drilldown === 'pending-assessments' ? 'Assessments that remain available for you to complete.' : 'Everything currently available in your learning queue.'}</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-3">
                                    {pagedAssessments.length ? (
                                        pagedAssessments.map((exam) => (
                                            <div key={exam.id} className="rounded-lg border p-4">
                                                <div className="flex flex-wrap items-start justify-between gap-3">
                                                    <div>
                                                        <div className="flex items-center gap-2">
                                                            <Badge variant="outline">{exam.assessmentKind ?? 'PRACTICE'}</Badge>
                                                            {exam.countsTowardPerformance ? <Badge>Performance</Badge> : null}
                                                            {exam.awardsStars && exam.starValue ? <Badge variant="secondary">+{exam.starValue} stars</Badge> : null}
                                                            {exam.certificateEligible ? <Badge variant="outline">Certificate on pass</Badge> : null}
                                                        </div>
                                                        <p className="mt-3 font-semibold">{exam.title}</p>
                                                        <p className="mt-1 text-sm text-muted-foreground">
                                                            {exam.domain?.name ?? 'General Training'}
                                                            {exam.learningEvent?.title ? ` · ${exam.learningEvent.title}` : ''}
                                                            {exam.deadline ? ` · due ${new Date(exam.deadline).toLocaleDateString()}` : ''}
                                                        </p>
                                                        <div className="mt-2 flex flex-wrap gap-2">
                                                            {exam.userStatus.hasPassed ? <Badge>Passed</Badge> : null}
                                                            {exam.userStatus.hasInProgressAttempt ? <Badge variant="outline">In Progress</Badge> : null}
                                                            {!exam.userStatus.hasPassed && !exam.userStatus.hasInProgressAttempt ? (
                                                                <Badge variant="outline">{exam.userStatus.remainingAttempts} attempts left</Badge>
                                                            ) : null}
                                                            {exam.userStatus.bestScore !== null && exam.userStatus.bestScore !== undefined ? (
                                                                <Badge variant="outline">Best {Math.round(exam.userStatus.bestScore)}%</Badge>
                                                            ) : null}
                                                        </div>
                                                    </div>
                                                    <Link href={`/exams/${exam.id}`}>
                                                        <Button variant="ghost" size="sm">Open</Button>
                                                    </Link>
                                                </div>
                                            </div>
                                        ))
                                    ) : (
                                        <p className="text-sm text-muted-foreground">No assigned assessments yet.</p>
                                    )}
                                    <PaginationControls
                                        page={assessmentPage}
                                        totalItems={visibleAssignedExams.length}
                                        onPageChange={setAssessmentPage}
                                    />
                                </CardContent>
                            </Card>
                        </div>

                        <div className="grid gap-6 lg:grid-cols-5">
                            <Card id="study-activity" className="scroll-mt-24 lg:col-span-3">
                                <CardHeader>
                                    <CardTitle>Study Activity</CardTitle>
                                    <CardDescription>Minutes watched per session.</CardDescription>
                                </CardHeader>
                                <CardContent className="h-[300px]">
                                    {activityChartData.length ? (
                                        <ResponsiveContainer width="100%" height="100%">
                                            <LineChart data={activityChartData}>
                                                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                                                <XAxis dataKey="date" tick={{ fontSize: 12 }} tickLine={false} axisLine={false} />
                                                <YAxis tick={{ fontSize: 12 }} tickLine={false} axisLine={false} />
                                                <RechartsTooltip />
                                                <Line type="monotone" dataKey="minutes" stroke="#0ea5e9" strokeWidth={2} dot={false} />
                                            </LineChart>
                                        </ResponsiveContainer>
                                    ) : (
                                        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                                            No recent activity logged yet.
                                        </div>
                                    )}
                                </CardContent>
                            </Card>

                            <Card className="lg:col-span-2">
                                <CardHeader>
                                    <CardTitle>Recent Learning Activity</CardTitle>
                                    <CardDescription>Latest lessons you interacted with.</CardDescription>
                                </CardHeader>
                                <CardContent>
                                    <div className="max-h-[280px] space-y-3 overflow-y-auto pr-2">
                                        {filteredActivity.length ? (
                                            filteredActivity.map((entry) => (
                                                <div key={entry.id} className="rounded-lg border p-3">
                                                    <div className="flex items-center justify-between">
                                                        <p className="text-sm font-medium">{entry.lessonTitle}</p>
                                                        <span className="text-xs text-muted-foreground">{formatDate(entry.updatedAt)}</span>
                                                    </div>
                                                    <p className="text-xs text-muted-foreground">{entry.courseTitle}</p>
                                                    <div className="mt-2 flex items-center justify-between text-xs">
                                                        <span className="flex items-center gap-1">
                                                            <Play className="h-3 w-3" />
                                                            {Math.round(entry.watchedDuration / 60)} min watched
                                                        </span>
                                                        <Badge variant={entry.completed ? 'default' : 'outline'}>
                                                            {entry.completed ? 'Completed' : 'In progress'}
                                                        </Badge>
                                                    </div>
                                                </div>
                                            ))
                                        ) : (
                                            <p className="text-sm text-muted-foreground">No lessons started yet.</p>
                                        )}
                                    </div>
                                </CardContent>
                            </Card>
                        </div>

                        <div className="grid gap-6 xl:grid-cols-[1.1fr_1.4fr]">
                            <Card id="upcoming-events" className="scroll-mt-24">
                                <CardHeader>
                                    <CardTitle>Upcoming Learning Events</CardTitle>
                                    <CardDescription>Event-linked sessions associated with your assigned learning.</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-3">
                                    {pagedEvents.length ? (
                                        pagedEvents.map((event) => (
                                            <div key={event.id} className="rounded-lg border p-4">
                                                <div className="flex flex-wrap items-start justify-between gap-3">
                                                    <div>
                                                        <div className="flex items-center gap-2">
                                                            <Badge variant="outline">{event.format.replaceAll('_', ' ')}</Badge>
                                                            {event.isRequired ? <Badge>Required</Badge> : null}
                                                        </div>
                                                        {event.linkedExams[0] ? (
                                                            <Link href={`/exams/${event.linkedExams[0].id}`} className="mt-3 block font-semibold hover:text-[#006688] hover:underline">
                                                                {event.title}
                                                            </Link>
                                                        ) : (
                                                            <p className="mt-3 font-semibold">{event.title}</p>
                                                        )}
                                                        <p className="mt-1 text-sm text-muted-foreground">
                                                            {event.domain?.name ?? 'General Training'} · {event.scheduledAt ? new Date(event.scheduledAt).toLocaleString() : 'Schedule pending'}
                                                        </p>
                                                    </div>
                                                    <Badge variant="secondary">{event.linkedExams.length} linked exams</Badge>
                                                </div>
                                                <div className="mt-3 flex flex-wrap gap-2">
                                                    {event.linkedExams.slice(0, 3).map((exam) => (
                                                        <Link key={exam.id} href={`/exams/${exam.id}`}>
                                                            <Badge variant="outline">{exam.title}</Badge>
                                                        </Link>
                                                    ))}
                                                    {event.linkedExams[0] ? (
                                                        <Link href={`/exams/${event.linkedExams[0].id}`}>
                                                            <Button variant="outline" size="sm">Open assessment</Button>
                                                        </Link>
                                                    ) : null}
                                                </div>
                                            </div>
                                        ))
                                    ) : (
                                        <p className="text-sm text-muted-foreground">No upcoming linked events.</p>
                                    )}
                                    <PaginationControls
                                        page={eventPage}
                                        totalItems={filteredEvents.length}
                                        onPageChange={setEventPage}
                                    />
                                </CardContent>
                            </Card>

                            <Card id="recent-completions" className="scroll-mt-24">
                                <CardHeader>
                                    <CardTitle>{drilldown === 'passed-assessments' ? 'Passed Assessments' : 'Recent Completions'}</CardTitle>
                                    <CardDescription>{drilldown === 'passed-assessments' ? 'Your submitted or graded assessments that passed.' : 'Your latest submitted or graded attempts.'}</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-3">
                                    {visibleRecentCompletions.length ? (
                                        visibleRecentCompletions.map((attempt) => (
                                            <div key={attempt.attemptId} className="rounded-lg border p-4">
                                                <div className="flex flex-wrap items-start justify-between gap-3">
                                                    <div>
                                                        <div className="flex items-center gap-2">
                                                            <Badge variant="outline">{attempt.assessmentKind ?? 'PRACTICE'}</Badge>
                                                            {attempt.passed ? <Badge>Passed</Badge> : <Badge variant="destructive">Not Passed</Badge>}
                                                        </div>
                                                        <p className="mt-3 font-semibold">{attempt.examTitle}</p>
                                                        <p className="mt-1 text-sm text-muted-foreground">
                                                            {attempt.domainName ?? 'General Training'}
                                                            {attempt.eventTitle ? ` · ${attempt.eventTitle}` : ''}
                                                            {attempt.submittedAt ? ` · ${new Date(attempt.submittedAt).toLocaleDateString()}` : ''}
                                                        </p>
                                                    </div>
                                                    <div className="text-right">
                                                        <p className="text-2xl font-semibold">
                                                            {attempt.percentageScore !== null && attempt.percentageScore !== undefined
                                                                ? `${Math.round(attempt.percentageScore)}%`
                                                                : 'Pending'}
                                                        </p>
                                                        <Link href={`/exams/${attempt.examId}/result?attemptId=${attempt.attemptId}`}>
                                                            <Button variant="ghost" size="sm">Review</Button>
                                                        </Link>
                                                    </div>
                                                </div>
                                            </div>
                                        ))
                                    ) : (
                                        <p className="text-sm text-muted-foreground">No completed attempts yet.</p>
                                    )}
                                </CardContent>
                            </Card>
                        </div>

                        <Card>
                            <CardHeader>
                                <CardTitle>Upcoming Targets</CardTitle>
                                <CardDescription>Suggested completion targets based on enrollment dates.</CardDescription>
                            </CardHeader>
                            <CardContent>
                                <div className="max-h-[280px] space-y-3 overflow-y-auto pr-2">
                                    {pagedTargets.length ? (
                                        pagedTargets.map((deadline) => {
                                            const daysLeft = Math.max(
                                                0,
                                                Math.ceil(
                                                    (new Date(deadline.deadline).getTime() - Date.now()) /
                                                        (1000 * 60 * 60 * 24)
                                                )
                                            )

                                            return (
                                                <div key={deadline.courseId} className="rounded-lg border p-3">
                                                    <div className="flex items-center justify-between">
                                                        <p className="font-medium">{deadline.title}</p>
                                                        <Badge variant="outline">
                                                            {formatDate(deadline.deadline)}
                                                        </Badge>
                                                    </div>
                                                    <p className="mb-2 text-xs text-muted-foreground">
                                                        {deadline.status === 'COMPLETED' ? 'Completed' : `${daysLeft} days remaining`}
                                                    </p>
                                                    <div className="flex items-center justify-between text-sm">
                                                        <div className="w-40">
                                                            <div className="mb-1 flex items-center justify-between text-xs">
                                                                <span>Progress</span>
                                                                <span className="font-medium">{deadline.progress}%</span>
                                                            </div>
                                                            <Progress value={deadline.progress} />
                                                        </div>
                                                        <div className="flex items-center gap-2">
                                                            {deadline.status !== 'COMPLETED' ? (
                                                                <Badge variant="secondary">In progress</Badge>
                                                            ) : null}
                                                            <Link href={`/courses/${deadline.slug}`}>
                                                                <Button variant="outline" size="sm">Open course</Button>
                                                            </Link>
                                                        </div>
                                                    </div>
                                                </div>
                                            )
                                        })
                                    ) : (
                                        <p className="text-sm text-muted-foreground">
                                            No upcoming targets. Enroll in a course to get started.
                                        </p>
                                    )}
                                    <PaginationControls
                                        page={targetPage}
                                        totalItems={filteredTargets.length}
                                        onPageChange={setTargetPage}
                                    />
                                </div>
                            </CardContent>
                        </Card>
                    </>
                )}
            </div>
        </DashboardLayout>
    )
}

function SummaryCard({
    href,
    title,
    value,
    helper,
    icon: Icon,
}: {
    href: string
    title: string
    value: number
    helper: string
    icon: React.ComponentType<{ className?: string }>
}) {
    return (
        <Link href={href} className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#008ebc] focus-visible:ring-offset-2">
            <Card className="h-full transition-colors hover:border-[#008ebc] hover:bg-cyan-50/40">
                <CardHeader className="pb-2">
                    <CardDescription>{title}</CardDescription>
                    <CardTitle className="text-3xl">{value}</CardTitle>
                </CardHeader>
                <CardContent className="flex items-center justify-between">
                    <p className="text-sm text-muted-foreground">{helper}</p>
                    <Icon className="h-5 w-5 text-[#006688]" />
                </CardContent>
            </Card>
        </Link>
    )
}

function PaginationControls({
    page,
    totalItems,
    onPageChange,
}: {
    page: number
    totalItems: number
    onPageChange: (page: number) => void
}) {
    const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE))
    if (totalItems <= PAGE_SIZE) return null

    return (
        <div className="flex items-center justify-between border-t pt-3">
            <p className="text-xs text-muted-foreground">
                Page {page} of {totalPages} · {totalItems} items
            </p>
            <div className="flex items-center gap-1">
                <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-8 w-8"
                    disabled={page <= 1}
                    onClick={() => onPageChange(Math.max(1, page - 1))}
                    aria-label="Previous page"
                    title="Previous page"
                >
                    <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-8 w-8"
                    disabled={page >= totalPages}
                    onClick={() => onPageChange(Math.min(totalPages, page + 1))}
                    aria-label="Next page"
                    title="Next page"
                >
                    <ChevronRight className="h-4 w-4" />
                </Button>
            </div>
        </div>
    )
}
