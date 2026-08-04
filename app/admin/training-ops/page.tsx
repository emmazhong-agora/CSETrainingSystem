'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { DashboardLayout } from '@/components/layout/dashboard-layout'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ScrollArea } from '@/components/ui/scroll-area'
import { OpsHero, SectionHeading, SignalCard } from '@/components/training-ops/overview-primitives'
import { ApiClient } from '@/lib/api-client'
import type { TrainingOpsAdminReport, TrainingOpsLearnerRiskStatus, TrainingOpsReportRange } from '@/types'
import {
    AlertTriangle,
    BarChart3,
    BookOpen,
    CalendarDays,
    CheckCircle2,
    Download,
    FileText,
    GraduationCap,
    Loader2,
    Search,
    Settings2,
    ShieldAlert,
    Target,
    Users,
} from 'lucide-react'

const riskTone: Record<TrainingOpsLearnerRiskStatus, string> = {
    ON_TRACK: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    WATCH: 'border-amber-200 bg-amber-50 text-amber-700',
    AT_RISK: 'border-rose-200 bg-rose-50 text-rose-700',
    NO_ASSIGNMENT: 'border-slate-200 bg-slate-100 text-slate-700',
}

const domainTone: Record<TrainingOpsAdminReport['domainProgress'][number]['status'], string> = {
    ON_TRACK: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    MONITOR: 'border-amber-200 bg-amber-50 text-amber-700',
    AT_RISK: 'border-rose-200 bg-rose-50 text-rose-700',
    INSUFFICIENT_DATA: 'border-slate-200 bg-slate-100 text-slate-700',
}

const formatDate = (value: string | Date | null | undefined) => {
    if (!value) return 'No activity'
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return 'No activity'
    return date.toLocaleDateString()
}

const formatStatus = (value: string) => value.replaceAll('_', ' ')

const RANGE_OPTIONS: Array<{ value: TrainingOpsReportRange; label: string }> = [
    { value: '30d', label: 'Past 1 month' },
    { value: '90d', label: 'Past 3 months' },
    { value: '180d', label: 'Past 6 months' },
    { value: '365d', label: 'Past year' },
    { value: 'ytd', label: 'This year' },
    { value: 'all', label: 'All time' },
]

type LearnerActionFilter = 'overdue' | 'retake' | 'no-attempt' | 'learning-stalled'

const ACTION_FILTER_LABELS: Record<LearnerActionFilter, string> = {
    overdue: 'Overdue assessment',
    retake: 'Retake available',
    'no-attempt': 'No attempt yet',
    'learning-stalled': 'Learning stalled',
}

const isLearnerActionFilter = (value: string | null): value is LearnerActionFilter =>
    value === 'overdue' || value === 'retake' || value === 'no-attempt' || value === 'learning-stalled'

const exportLearnersCsv = (report: TrainingOpsAdminReport) => {
    const headers = [
        'Name',
        'Email',
        'Role',
        'Department',
        'Risk',
        'Course Assigned',
        'Course Completed',
        'Course Progress',
        'Invited Assessments',
        'Invited Assessments Attempted',
        'Total Submissions',
        'Pass Rate',
        'Average Score',
        'Best Score',
        'Certificates',
        'Retake Needed',
        'Overdue Exams',
        'Last Activity',
    ]
    const rows = report.learnerPerformance.map((learner) => [
        learner.name,
        learner.email,
        learner.role,
        learner.department ?? '',
        learner.riskStatus,
        learner.courseAssigned,
        learner.courseCompleted,
        `${learner.averageCourseProgress}%`,
        learner.examInvitations,
        learner.examsAttempted,
        learner.examAttempts,
        `${learner.passRate}%`,
        `${learner.averageScore}%`,
        `${learner.bestScore}%`,
        learner.certificates,
        learner.retakeNeeded,
        learner.overdueExams,
        learner.lastActivityAt ? new Date(learner.lastActivityAt).toISOString() : '',
    ])
    const csv = [headers, ...rows]
        .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(','))
        .join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `training-ops-learners-${new Date().toISOString().slice(0, 10)}.csv`
    link.click()
    URL.revokeObjectURL(url)
}

export default function TrainingOpsDashboardPage() {
    const searchParams = useSearchParams()
    const [report, setReport] = useState<TrainingOpsAdminReport | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [learnerSearch, setLearnerSearch] = useState('')
    const [range, setRange] = useState<TrainingOpsReportRange>('30d')
    const [includeAdmins, setIncludeAdmins] = useState(true)
    const [excludedUserIds, setExcludedUserIds] = useState<string[]>([])
    const [filterDialogOpen, setFilterDialogOpen] = useState(false)
    const requestedLearnerActionFilter = searchParams.get('learnerFilter')
    const learnerActionFilter = isLearnerActionFilter(requestedLearnerActionFilter)
        ? requestedLearnerActionFilter
        : null

    useEffect(() => {
        const loadData = async () => {
            try {
                setLoading(true)
                const response = await ApiClient.getTrainingOpsAdminReport({
                    range,
                    includeAdmins,
                    excludeUserIds: excludedUserIds,
                })
                setReport(response.data)
                setError(null)
            } catch (err) {
                setError(err instanceof Error ? err.message : 'Failed to load training operations report')
            } finally {
                setLoading(false)
            }
        }

        void loadData()
    }, [range, includeAdmins, excludedUserIds])

    const filteredLearners = useMemo(() => {
        if (!report) return []
        const query = learnerSearch.trim().toLowerCase()
        return report.learnerPerformance.filter((learner) => {
            const matchesAction = !learnerActionFilter || (
                learnerActionFilter === 'overdue' ? learner.overdueExams > 0 :
                    learnerActionFilter === 'retake' ? learner.retakeNeeded > 0 :
                        learnerActionFilter === 'no-attempt' ? learner.examInvitations > 0 && learner.examsAttempted === 0 :
                            learner.courseAssigned > 0 && learner.averageCourseProgress < 60
            )
            const matchesSearch = !query ||
                learner.name.toLowerCase().includes(query) ||
                learner.email.toLowerCase().includes(query) ||
                learner.role.toLowerCase().includes(query) ||
                learner.department?.toLowerCase().includes(query) ||
                learner.title?.toLowerCase().includes(query) ||
                learner.riskStatus.toLowerCase().includes(query)

            return matchesAction && matchesSearch
        })
    }, [learnerActionFilter, learnerSearch, report])

    const actionSummary = useMemo(() => {
        const learners = report?.learnerPerformance ?? []
        return {
            overdue: learners.filter((learner) => learner.overdueExams > 0).length,
            retake: learners.filter((learner) => learner.retakeNeeded > 0).length,
            noAttempt: learners.filter((learner) => learner.examInvitations > 0 && learner.examsAttempted === 0).length,
            lowProgress: learners.filter((learner) => learner.courseAssigned > 0 && learner.averageCourseProgress < 60).length,
        }
    }, [report])

    const measuredDomains = report?.domainProgress.filter((domain) => domain.gradedAttempts > 0) ?? []
    const unmeasuredDomains = report?.domainProgress.filter((domain) => domain.gradedAttempts === 0) ?? []
    const activeFilterCount = (includeAdmins ? 0 : 1) + excludedUserIds.length

    const toggleExcludedUser = (userId: string, checked: boolean) => {
        setExcludedUserIds((prev) => checked ? [...prev, userId] : prev.filter((id) => id !== userId))
    }

    return (
        <DashboardLayout>
            <div className="space-y-8 pb-8">
                <OpsHero
                    eyebrow="Admin · Training Ops"
                    title="Team learning health, without the reporting fog."
                    description="See whether the team is participating, completing required work, building verified capability, and where intervention is needed next."
                    scope={includeAdmins ? 'All active learning roles' : 'Learners & SMEs only'}
                    meta={report ? `${report.period.label} · generated ${formatDate(report.generatedAt)}` : 'Loading current period'}
                    actions={(
                        <>
                            <Select value={range} onValueChange={(value) => setRange(value as TrainingOpsReportRange)}>
                                <SelectTrigger className="w-40 border-white/20 bg-white text-slate-900">
                                    <SelectValue placeholder="Select range" />
                                </SelectTrigger>
                                <SelectContent>
                                    {RANGE_OPTIONS.map((option) => (
                                        <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <Dialog open={filterDialogOpen} onOpenChange={setFilterDialogOpen}>
                                <DialogTrigger asChild>
                                    <Button variant="outline" className="border-white/20 bg-white/10 text-white hover:bg-white hover:text-slate-950">
                                        <Settings2 className="mr-2 h-4 w-4" />
                                        Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
                                    </Button>
                                </DialogTrigger>
                                <DialogContent className="max-w-2xl">
                                    <DialogHeader>
                                        <DialogTitle>Report scope</DialogTitle>
                                        <DialogDescription>Choose which active roles count as learners, then exclude test or service accounts individually.</DialogDescription>
                                    </DialogHeader>
                                    <div className="space-y-6">
                                        <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 p-4">
                                            <div className="space-y-1">
                                                <Label htmlFor="include-admins">Include Admin-role learners</Label>
                                                <p className="text-sm text-slate-500">On by default because Admin users can also receive courses and exams.</p>
                                            </div>
                                            <Switch id="include-admins" checked={includeAdmins} onCheckedChange={setIncludeAdmins} />
                                        </div>
                                        <div className="space-y-3">
                                            <div className="flex items-center justify-between">
                                                <div>
                                                    <Label>Exclude users</Label>
                                                    <p className="text-sm text-slate-500">Remove test accounts or out-of-scope team members.</p>
                                                </div>
                                                {excludedUserIds.length > 0 ? (
                                                    <Button variant="ghost" size="sm" onClick={() => setExcludedUserIds([])}>Clear all</Button>
                                                ) : null}
                                            </div>
                                            <ScrollArea className="h-72 rounded-xl border border-slate-200">
                                                <div className="space-y-2 p-3">
                                                    {(report?.availableUsers ?? []).map((user) => {
                                                        const checked = excludedUserIds.includes(user.userId)
                                                        return (
                                                            <label key={user.userId} className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 bg-white p-3">
                                                                <input
                                                                    type="checkbox"
                                                                    className="mt-1 h-4 w-4 rounded border-slate-300"
                                                                    checked={checked}
                                                                    onChange={(event) => toggleExcludedUser(user.userId, event.target.checked)}
                                                                />
                                                                <div className="min-w-0">
                                                                    <div className="flex flex-wrap items-center gap-2">
                                                                        <p className="font-medium text-slate-950">{user.name}</p>
                                                                        <Badge variant="outline">{user.role}</Badge>
                                                                    </div>
                                                                    <p className="text-sm text-slate-500">{user.email}</p>
                                                                </div>
                                                            </label>
                                                        )
                                                    })}
                                                </div>
                                            </ScrollArea>
                                        </div>
                                    </div>
                                    <DialogFooter><Button variant="outline" onClick={() => setFilterDialogOpen(false)}>Done</Button></DialogFooter>
                                </DialogContent>
                            </Dialog>
                            <Button
                                disabled={!report}
                                onClick={() => report ? exportLearnersCsv(report) : undefined}
                                className="bg-[#00b7df] text-[#05202a] hover:bg-[#67dcf3]"
                            >
                                <Download className="mr-2 h-4 w-4" />Export
                            </Button>
                        </>
                    )}
                />

                {error ? (
                    <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
                        Training Ops data is unavailable: {error}
                    </div>
                ) : null}

                {loading || !report ? (
                    <Card className="border-slate-200 bg-white shadow-sm">
                        <CardContent className="flex h-72 items-center justify-center text-slate-500">
                            <Loader2 className="mr-2 h-5 w-5 animate-spin" />Loading team learning health...
                        </CardContent>
                    </Card>
                ) : (
                    <>
                        <section aria-label="Team health signals" className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
                            <SignalCard
                                label="Learning-active users"
                                value={report.summary.activeLearners}
                                denominator={`/ ${report.summary.teamMembers}`}
                                hint="Users with course, assessment, or certificate activity in the selected period; login alone does not count."
                                icon={Users}
                                tone="positive"
                            />
                            <SignalCard
                                label="Content completed"
                                value={`${report.summary.courseCompletionRate}%`}
                                denominator={`${report.summary.courseCompleted}/${report.summary.courseAssignments}`}
                                hint={`${report.summary.courseStarted} assigned course records have been started.`}
                                icon={BookOpen}
                            />
                            <SignalCard
                                label="Assessment coverage"
                                value={`${report.summary.examParticipationRate}%`}
                                denominator={`${report.summary.invitationParticipatingLearners}/${report.summary.invitedLearners}`}
                                hint="Learners participating among those with published invitations."
                                icon={FileText}
                            />
                            <SignalCard
                                label="Performance evidence"
                                value={report.summary.performanceEvidenceRecords > 0 ? `${report.summary.performancePassRate}%` : 'No data'}
                                denominator={report.summary.performanceEvidenceRecords > 0 ? `${report.summary.performanceEvidenceRecords} records` : undefined}
                                hint={report.summary.performanceEvidenceRecords > 0
                                    ? `Latest learner-exam evidence only · ${report.summary.performanceAverageScore}% average.`
                                    : 'No graded performance-counting evidence in this period.'}
                                icon={GraduationCap}
                                tone={report.summary.performanceEvidenceRecords === 0 ? 'warning' : 'positive'}
                            />
                            <SignalCard
                                label="Action required"
                                value={report.summary.atRiskLearners}
                                denominator={`${report.summary.watchLearners} watch`}
                                hint={`${report.summary.overdueLearners} overdue · ${report.summary.retakeNeeded} actionable retakes.`}
                                icon={ShieldAlert}
                                tone={report.summary.atRiskLearners > 0 ? 'risk' : 'positive'}
                            />
                        </section>

                        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-cyan-200 bg-cyan-50/70 px-5 py-4 text-sm text-slate-700">
                            <div className="flex items-center gap-3">
                                <Target className="h-5 w-5 text-[#006688]" />
                                <span>
                                    <strong className="text-slate-950">Capability coverage:</strong>{' '}
                                    {report.summary.measuredDomains} of {report.summary.trackedDomains} tracked domains have graded evidence.
                                </span>
                            </div>
                            {report.summary.measuredDomains < report.summary.trackedDomains ? (
                                <span className="rounded-full border border-cyan-200 bg-white px-3 py-1 text-xs font-medium text-[#006688]">
                                    No data is not a zero score
                                </span>
                            ) : null}
                        </div>

                        <section id="action-center" className="scroll-mt-24 space-y-5">
                            <SectionHeading
                                eyebrow="Intervention"
                                title="Action Center"
                                description="Current open obligations across all assignments, ordered by overdue work, retakes, missing attempts, and stalled learning."
                            />
                            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                                {[
                                    { filter: 'overdue' as const, label: 'Overdue assessment', value: actionSummary.overdue, hint: 'Past deadline with no attempt', tone: 'border-rose-200 bg-rose-50 text-rose-800' },
                                    { filter: 'retake' as const, label: 'Retake available', value: actionSummary.retake, hint: 'Failed with attempts remaining', tone: 'border-amber-200 bg-amber-50 text-amber-800' },
                                    { filter: 'no-attempt' as const, label: 'No attempt yet', value: actionSummary.noAttempt, hint: 'Invited but not submitted', tone: 'border-sky-200 bg-sky-50 text-sky-800' },
                                    { filter: 'learning-stalled' as const, label: 'Learning stalled', value: actionSummary.lowProgress, hint: 'Assigned and below 60%', tone: 'border-slate-200 bg-slate-50 text-slate-800' },
                                ].map((item) => (
                                    <Link
                                        key={item.label}
                                        href={`/admin/training-ops?learnerFilter=${item.filter}#people`}
                                        className={`group rounded-2xl border p-5 transition-colors hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#008ebc] focus-visible:ring-offset-2 ${item.tone}`}
                                    >
                                        <p className="text-xs font-semibold uppercase tracking-[0.15em] opacity-70">{item.label}</p>
                                        <p className="mt-3 text-3xl font-semibold tracking-[-0.04em]">{item.value}</p>
                                        <p className="mt-2 text-sm opacity-75">{item.hint} · <span className="font-medium underline underline-offset-4">View learners</span></p>
                                    </Link>
                                ))}
                            </div>
                            <Card className="border-slate-200 bg-white shadow-sm">
                                <CardHeader>
                                    <CardTitle className="flex items-center gap-2 text-xl text-slate-950">
                                        <AlertTriangle className="h-5 w-5 text-rose-600" />Priority queue
                                    </CardTitle>
                                    <CardDescription>Current follow-up needs. The selected date range affects trend metrics, not open obligations.</CardDescription>
                                </CardHeader>
                                <CardContent>
                                    {report.riskQueue.length === 0 ? (
                                        <div className="rounded-xl border border-dashed border-slate-200 p-6 text-sm text-slate-500">No learners currently require follow-up.</div>
                                    ) : (
                                        <div className="grid gap-3 lg:grid-cols-2">
                                            {report.riskQueue.slice(0, 8).map((item) => (
                                                <div key={item.userId} className="flex flex-col justify-between gap-4 rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
                                                    <div className="min-w-0">
                                                        <div className="flex flex-wrap items-center gap-2">
                                                            <p className="font-semibold text-slate-950">{item.name}</p>
                                                            <Badge variant="outline" className={riskTone[item.riskStatus]}>{formatStatus(item.riskStatus)}</Badge>
                                                            <Badge variant="outline" className="bg-white">{item.role}</Badge>
                                                        </div>
                                                        <p className="truncate text-sm text-slate-500">{item.email}</p>
                                                        <p className="mt-2 text-sm leading-6 text-slate-700">{item.reason}</p>
                                                    </div>
                                                    <div className="flex flex-wrap gap-2 text-xs">
                                                        {item.courseAssigned > 0 ? (
                                                            <Badge variant="outline" className="bg-white">Learning {item.averageCourseProgress}%</Badge>
                                                        ) : null}
                                                        {item.examInvitations > 0 ? (
                                                            <Badge variant="outline" className="bg-white">Assessments {item.examsAttempted}/{item.examInvitations}</Badge>
                                                        ) : null}
                                                        <Badge variant="outline" className="bg-white">
                                                            {item.gradedAttempts > 0 ? `Pass ${item.passRate}%` : 'No graded evidence'}
                                                        </Badge>
                                                        <Badge variant="outline" className="bg-white">Last learning activity: {formatDate(item.lastActivityAt)}</Badge>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                        </section>

                        <section className="space-y-5">
                            <SectionHeading
                                eyebrow="Capability coverage"
                                title="Measured domains first"
                                description="Domains without graded evidence are coverage gaps, not zero mastery scores."
                                action={(
                                    <Link href="/admin/training-ops/effectiveness"><Button variant="outline"><BarChart3 className="mr-2 h-4 w-4" />Open full board</Button></Link>
                                )}
                            />
                            <div className="grid gap-4 lg:grid-cols-2">
                                {measuredDomains.map((domain) => (
                                    <Card key={domain.id} className="border-slate-200 bg-white shadow-sm">
                                        <CardContent className="p-5">
                                            <div className="flex flex-wrap items-start justify-between gap-3">
                                                <div>
                                                    <div className="flex flex-wrap items-center gap-2">
                                                        <h3 className="font-semibold text-slate-950">{domain.name}</h3>
                                                        <Badge variant="outline" className={domainTone[domain.status]}>{formatStatus(domain.status)}</Badge>
                                                    </div>
                                                    <p className="mt-1 text-sm text-slate-500">{domain.ownerName ?? 'No SME owner'} · {domain.gradedAttempts} graded attempts</p>
                                                </div>
                                                <div className="text-right">
                                                    <p className="text-3xl font-semibold tracking-[-0.04em] text-slate-950">{domain.currentPassRate}%</p>
                                                    <p className="text-xs text-slate-500">Target {domain.targetPassRate ?? 'N/A'}%</p>
                                                </div>
                                            </div>
                                            <Progress value={domain.currentPassRate} className="mt-5 h-2" />
                                        </CardContent>
                                    </Card>
                                ))}
                            </div>
                            {unmeasuredDomains.length > 0 ? (
                                <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50/70 p-5">
                                    <p className="text-sm font-semibold text-slate-800">Coverage setup needed</p>
                                    <p className="mt-1 text-sm text-slate-500">{unmeasuredDomains.length} domains have no graded evidence in this period.</p>
                                    <div className="mt-4 flex flex-wrap gap-2">
                                        {unmeasuredDomains.map((domain) => <Badge key={domain.id} variant="outline" className="bg-white">{domain.name} · No data</Badge>)}
                                    </div>
                                </div>
                            ) : null}
                        </section>

                        <section id="people" className="space-y-5">
                            <SectionHeading
                                eyebrow="Drill-down"
                                title="Learner evidence"
                                description="Current cumulative assignments and assessment evidence. Use the table for investigation and export; the Action Center remains the intervention view."
                            />
                            <Card className="border-slate-200 bg-white shadow-sm">
                                <CardHeader>
                                    <div className="flex flex-wrap items-center justify-between gap-4">
                                        <div>
                                            <CardTitle className="text-xl text-slate-950">
                                                {learnerActionFilter ? ACTION_FILTER_LABELS[learnerActionFilter] : 'All learners'}
                                            </CardTitle>
                                            <CardDescription>
                                                {filteredLearners.length} learners in the current scope.
                                                {learnerActionFilter ? ' This list is filtered from Action Center.' : ''}
                                            </CardDescription>
                                        </div>
                                        <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto">
                                            {learnerActionFilter ? (
                                                <Link href="/admin/training-ops#people">
                                                    <Button variant="outline" size="sm">Clear action filter</Button>
                                                </Link>
                                            ) : null}
                                            <div className="relative w-full sm:w-80">
                                                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                                                <Input value={learnerSearch} onChange={(event) => setLearnerSearch(event.target.value)} placeholder="Search learner, team, risk" className="pl-9" />
                                            </div>
                                        </div>
                                    </div>
                                </CardHeader>
                                <CardContent>
                                    <div className="overflow-x-auto rounded-xl border border-slate-200">
                                        <table className="min-w-full text-sm">
                                            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                                                <tr>
                                                    <th className="px-4 py-3">Learner</th>
                                                    <th className="px-4 py-3">Status</th>
                                                    <th className="px-4 py-3">Learning</th>
                                                    <th className="px-4 py-3">Assessment</th>
                                                    <th className="px-4 py-3">Evidence</th>
                                                    <th className="px-4 py-3">Follow-up</th>
                                                    <th className="px-4 py-3">Last activity</th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-slate-200">
                                                {filteredLearners.map((learner) => (
                                                    <tr key={learner.userId} className="align-top hover:bg-slate-50/70">
                                                        <td className="px-4 py-4">
                                                            <p className="font-semibold text-slate-950">{learner.name}</p>
                                                            <p className="text-xs text-slate-500">{learner.email}</p>
                                                            <Badge variant="outline" className="mt-2 bg-white">{learner.role}</Badge>
                                                        </td>
                                                        <td className="px-4 py-4"><Badge variant="outline" className={riskTone[learner.riskStatus]}>{formatStatus(learner.riskStatus)}</Badge></td>
                                                        <td className="px-4 py-4">
                                                            {learner.courseAssigned > 0 ? (
                                                                <>
                                                                    <p className="font-medium text-slate-800">{learner.courseCompleted}/{learner.courseAssigned} complete</p>
                                                                    <p className="text-xs text-slate-500">{learner.averageCourseProgress}% average progress</p>
                                                                </>
                                                            ) : (
                                                                <p className="text-slate-500">No course assignment</p>
                                                            )}
                                                        </td>
                                                        <td className="px-4 py-4">
                                                            {learner.examInvitations > 0 ? (
                                                                <p className="font-medium text-slate-800">{learner.examsAttempted}/{learner.examInvitations} assessments attempted</p>
                                                            ) : (
                                                                <p className="text-slate-500">No exam invitation</p>
                                                            )}
                                                            <p className="text-xs text-slate-500">{learner.examAttempts} submissions · {learner.gradedAttempts} current graded results</p>
                                                        </td>
                                                        <td className="px-4 py-4">
                                                            {learner.gradedAttempts > 0 ? (
                                                                <>
                                                                    <p className="font-medium text-slate-800">{learner.passRate}% pass · {learner.averageScore}% avg</p>
                                                                    <p className="text-xs text-slate-500">Best {learner.bestScore}%</p>
                                                                </>
                                                            ) : (
                                                                <p className="text-slate-500">No graded evidence</p>
                                                            )}
                                                        </td>
                                                        <td className="px-4 py-4">
                                                            {learner.overdueExams === 0 && learner.retakeNeeded === 0 ? (
                                                                <p className="text-slate-500">No open follow-up</p>
                                                            ) : (
                                                                <>
                                                                    <p className={learner.overdueExams > 0 ? 'font-medium text-rose-700' : 'text-slate-600'}>{learner.overdueExams} overdue</p>
                                                                    <p className={learner.retakeNeeded > 0 ? 'text-amber-700' : 'text-xs text-slate-500'}>{learner.retakeNeeded} retakes</p>
                                                                </>
                                                            )}
                                                        </td>
                                                        <td className="whitespace-nowrap px-4 py-4 text-slate-500">{formatDate(learner.lastActivityAt)}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                </CardContent>
                            </Card>
                        </section>

                        <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-6">
                            <Link href="/admin/training-ops/series"><Button variant="outline"><GraduationCap className="mr-2 h-4 w-4" />Learning Programs</Button></Link>
                            <Link href="/admin/training-ops/events"><Button variant="outline"><CalendarDays className="mr-2 h-4 w-4" />Events</Button></Link>
                            <Link href="/admin/training-ops/domains"><Button variant="outline"><Target className="mr-2 h-4 w-4" />Domains & Ownership</Button></Link>
                            <Link href="/admin/training-ops/effectiveness"><Button variant="outline"><CheckCircle2 className="mr-2 h-4 w-4" />Effectiveness</Button></Link>
                        </div>
                    </>
                )}
            </div>
        </DashboardLayout>
    )
}
