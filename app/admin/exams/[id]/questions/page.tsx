'use client'

import { Suspense, useState, useEffect, use, useRef, useCallback, useMemo } from 'react'
import { useSearchParams } from 'next/navigation'
import { DashboardLayout } from '@/components/layout/dashboard-layout'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { RichTextEditor } from '@/components/ui/rich-text-editor'
import { RichTextContent } from '@/components/ui/rich-text-content'
import { ApiClient } from '@/lib/api-client'
import { resolveUploadedFileContentType } from '@/lib/file-upload'
import { stripRichTextToPlainText } from '@/lib/rich-text'
import {
    Loader2,
    Plus,
    Trash2,
    Edit,
    Sparkles,
    GripVertical,
    Save,
    X,
    CheckCircle,
    XCircle,
    Copy,
    Download,
    Paperclip,
    ExternalLink,
} from 'lucide-react'
import { BackButton } from '@/components/ui/back-button'
import Link from 'next/link'
import type { Exam, ExamQuestion, ExamQuestionType, EssayGradingCriterion } from '@/types'

const questionTypeLabels: Record<ExamQuestionType, string> = {
    SINGLE_CHOICE: 'Single Choice',
    MULTIPLE_CHOICE: 'Multiple Choice',
    TRUE_FALSE: 'True/False',
    FILL_IN_BLANK: 'Fill in Blank',
    ESSAY: 'Essay',
    EXERCISE: 'Exercise',
}

const DEFAULT_CHOICE_OPTIONS = ['', '', '', '']
const MIN_CHOICE_OPTIONS = 2
const MAX_CHOICE_OPTIONS = 6

const normalizeEditorOptions = (options?: string[] | null) => {
    const normalized = options?.length ? options.slice(0, MAX_CHOICE_OPTIONS) : [...DEFAULT_CHOICE_OPTIONS]
    while (normalized.length < MIN_CHOICE_OPTIONS) normalized.push('')
    return normalized
}

const difficultyColors: Record<string, string> = {
    EASY: 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-200',
    MEDIUM: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-200',
    HARD: 'bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-200',
}

type PageProps = {
    params: Promise<{ id: string }>
}

type ExamKnowledgeLesson = {
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
}

interface QuestionForm {
    type: ExamQuestionType
    question: string
    options: string[]
    correctAnswer: string
    multiCorrectAnswers: string[]
    explanation: string
    points: number
    difficulty: 'EASY' | 'MEDIUM' | 'HARD'
    maxWords?: number
    rubric?: string
    sampleAnswer?: string
    gradingCriteria: EssayGradingCriterion[]
    attachmentS3Key?: string
    attachmentFilename?: string
    attachmentMimeType?: string
    attachmentUrl?: string
}

const defaultQuestionForm: QuestionForm = {
    type: 'SINGLE_CHOICE',
    question: '',
    options: [...DEFAULT_CHOICE_OPTIONS],
    correctAnswer: '',
    multiCorrectAnswers: [],
    explanation: '',
    points: 10,
    difficulty: 'MEDIUM',
    gradingCriteria: [],
}

const createEmptyCriterion = (): EssayGradingCriterion => ({
    id: globalThis.crypto?.randomUUID?.() ?? `criterion-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: '',
    description: '',
    maxPoints: 1,
    guidance: '',
    required: false,
})

type EssayReadinessStatus = 'READY' | 'PARTIAL' | 'NOT_READY' | 'NOT_APPLICABLE'

type EssayQuestionHealthStatus = 'ready' | 'missing_criteria' | 'missing_sample' | 'points_mismatch' | 'needs_setup'

const getEssayQuestionHealth = (question: ExamQuestion) => {
    const criteria = question.gradingCriteria ?? []
    const criteriaPoints = criteria.reduce((sum, criterion) => sum + criterion.maxPoints, 0)
    const hasCriteria = criteria.length > 0
    const hasSampleAnswer = Boolean(question.sampleAnswer?.trim())

    let status: EssayQuestionHealthStatus = 'ready'
    if (!hasCriteria && !hasSampleAnswer) {
        status = 'needs_setup'
    } else if (!hasCriteria) {
        status = 'missing_criteria'
    } else if (!hasSampleAnswer) {
        status = 'missing_sample'
    } else if (criteriaPoints !== question.points) {
        status = 'points_mismatch'
    }

    return {
        status,
        criteriaCount: criteria.length,
        criteriaPoints,
        hasSampleAnswer,
        isReady: status === 'ready',
        readiness: status === 'ready'
            ? 'READY'
            : status === 'needs_setup'
                ? 'NOT_READY'
                : 'PARTIAL' as EssayReadinessStatus,
        detailLabel:
            status === 'ready'
                ? 'AI-ready'
                : status === 'missing_criteria'
                    ? 'Missing scoring points'
                    : status === 'missing_sample'
                        ? 'Missing sample answer'
                        : status === 'points_mismatch'
                            ? 'Point mismatch'
                            : 'Needs setup',
    }
}

const essayHealthTheme: Record<
    EssayReadinessStatus,
    { badge: string; shell: string; text: string }
> = {
    READY: {
        badge: 'border-emerald-200 bg-emerald-50 text-emerald-700',
        shell: 'border-emerald-200 bg-emerald-50/70',
        text: 'text-emerald-700',
    },
    PARTIAL: {
        badge: 'border-amber-200 bg-amber-50 text-amber-700',
        shell: 'border-amber-200 bg-amber-50/70',
        text: 'text-amber-700',
    },
    NOT_READY: {
        badge: 'border-rose-200 bg-rose-50 text-rose-700',
        shell: 'border-rose-200 bg-rose-50/70',
        text: 'text-rose-700',
    },
    NOT_APPLICABLE: {
        badge: 'border-slate-200 bg-slate-50 text-slate-700',
        shell: 'border-slate-200 bg-slate-50/80',
        text: 'text-slate-700',
    },
}

function ExamQuestionsPageContent({ params }: PageProps) {
    const { id: examId } = use(params)
    const searchParams = useSearchParams()
    const isSmeMode = searchParams.get('sme') === '1'
    const [exam, setExam] = useState<Exam | null>(null)
    const [questions, setQuestions] = useState<ExamQuestion[]>([])
    const formRef = useRef<HTMLDivElement | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [successMessage, setSuccessMessage] = useState<string | null>(null)
    const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
    const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
    const [selectedQuestionIds, setSelectedQuestionIds] = useState<string[]>([])
    const [confirmBulkDeleteOpen, setConfirmBulkDeleteOpen] = useState(false)
    const [bulkDeleting, setBulkDeleting] = useState(false)

    // Form state
    const [showForm, setShowForm] = useState(false)
    const [editingQuestion, setEditingQuestion] = useState<ExamQuestion | null>(null)
    const [form, setForm] = useState<QuestionForm>(defaultQuestionForm)
    const [attachmentFile, setAttachmentFile] = useState<File | null>(null)
    const [saving, setSaving] = useState(false)
    const [exportingContent, setExportingContent] = useState(false)

    // AI generation state
    const [showGenerateDialog, setShowGenerateDialog] = useState(false)
    const [generating, setGenerating] = useState(false)
    const [knowledgeLessons, setKnowledgeLessons] = useState<ExamKnowledgeLesson[]>([])
    const [knowledgeLessonsLoading, setKnowledgeLessonsLoading] = useState(false)
    const [knowledgeLessonsError, setKnowledgeLessonsError] = useState<string | null>(null)
    const [selectedLessonIds, setSelectedLessonIds] = useState<string[]>([])
    const [sourceMode, setSourceMode] = useState<'single' | 'multiple'>('single')
    const [generateConfig, setGenerateConfig] = useState({
        singleChoice: 3,
        multipleChoice: 5,
        trueFalse: 3,
        fillInBlank: 2,
        essay: 1,
        choiceOptionCount: 4 as 4 | 5 | 6,
        difficulty: 'mixed' as 'EASY' | 'MEDIUM' | 'HARD' | 'mixed',
    })

    const loadData = useCallback(async () => {
        setLoading(true)
        try {
            const [examRes, questionsRes] = await Promise.all([
                ApiClient.getAdminExam(examId),
                ApiClient.getExamQuestions(examId),
            ])
            setExam(examRes.data)
            setQuestions(questionsRes.data)
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load data')
        } finally {
            setLoading(false)
        }
    }, [examId])

    useEffect(() => {
        loadData()
    }, [loadData])

    useEffect(() => {
        setSelectedQuestionIds((prev) => prev.filter((id) => questions.some((q) => q.id === id)))
    }, [questions])

    useEffect(() => {
        if (!showGenerateDialog) return

        let cancelled = false
        const loadKnowledgeContexts = async () => {
            setKnowledgeLessonsLoading(true)
            setKnowledgeLessonsError(null)
            try {
                const response = await ApiClient.getExamKnowledgeContexts(examId)
                if (cancelled) return
                const lessons = (response.data?.lessons ?? []).slice().sort((a, b) => {
                    if (a.chapterOrder !== b.chapterOrder) return a.chapterOrder - b.chapterOrder
                    return a.lessonOrder - b.lessonOrder
                })
                setKnowledgeLessons(lessons)
                const readyLessons = lessons.filter((l) => l.knowledgeStatus === 'READY')
                const rebuildableLessons = lessons.filter((l) => l.hasTranscript)
                const defaultLesson = readyLessons[0] ?? rebuildableLessons[0] ?? null
                setSelectedLessonIds(defaultLesson ? [defaultLesson.lessonId] : [])
            } catch (err) {
                if (!cancelled) {
                    setKnowledgeLessonsError(err instanceof Error ? err.message : 'Failed to load knowledge contexts')
                    setKnowledgeLessons([])
                    setSelectedLessonIds([])
                }
            } finally {
                if (!cancelled) {
                    setKnowledgeLessonsLoading(false)
                }
            }
        }

        loadKnowledgeContexts()
        return () => {
            cancelled = true
        }
    }, [showGenerateDialog, examId])

    const essayQuestions = useMemo(
        () => questions.filter((question) => question.type === 'ESSAY'),
        [questions]
    )

    const essayScoringOverview = useMemo(() => {
        const details = essayQuestions.map((question) => ({
            question,
            ...getEssayQuestionHealth(question),
        }))

        const totalEssayQuestions = details.length
        const readyCount = details.filter((detail) => detail.readiness === 'READY').length
        const readiness: EssayReadinessStatus =
            totalEssayQuestions === 0
                ? 'NOT_APPLICABLE'
                : readyCount === totalEssayQuestions
                    ? 'READY'
                    : readyCount === 0
                        ? 'NOT_READY'
                        : 'PARTIAL'

        return {
            totalEssayQuestions,
            readyCount,
            missingCriteriaCount: details.filter((detail) => detail.status === 'missing_criteria').length,
            missingSampleCount: details.filter((detail) => detail.status === 'missing_sample').length,
            pointsMismatchCount: details.filter((detail) => detail.status === 'points_mismatch').length,
            needsSetupCount: details.filter((detail) => detail.status === 'needs_setup').length,
            readiness,
            details,
        }
    }, [essayQuestions])

    const closeQuestionForm = () => {
        setShowForm(false)
        setEditingQuestion(null)
        setForm(defaultQuestionForm)
        setAttachmentFile(null)
    }

    const handleCreateQuestion = () => {
        setEditingQuestion(null)
        setForm(defaultQuestionForm)
        setAttachmentFile(null)
        setShowForm(true)
        requestAnimationFrame(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    }

    const handleEditQuestion = (question: ExamQuestion) => {
        const parsedMultiAnswers = question.correctAnswer
            ? question.correctAnswer.split(',').map(s => s.trim()).filter(Boolean)
            : []

        setEditingQuestion(question)
        setForm({
            type: question.type,
            question: question.question,
            options: normalizeEditorOptions(question.options),
            correctAnswer: question.correctAnswer || '',
            multiCorrectAnswers: parsedMultiAnswers,
            explanation: question.explanation || '',
            points: question.points,
            difficulty: (question.difficulty as 'EASY' | 'MEDIUM' | 'HARD') || 'MEDIUM',
            maxWords: question.maxWords || undefined,
            rubric: question.rubric || undefined,
            sampleAnswer: question.sampleAnswer || undefined,
            gradingCriteria: question.gradingCriteria || [],
            attachmentS3Key: question.attachmentS3Key || undefined,
            attachmentFilename: question.attachmentFilename || undefined,
            attachmentMimeType: question.attachmentMimeType || undefined,
            attachmentUrl: question.attachmentUrl || undefined,
        })
        setAttachmentFile(null)
        setShowForm(true)
        requestAnimationFrame(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    }

    const handleDeleteQuestion = (questionId: string) => {
        setPendingDeleteId(questionId)
        setConfirmDeleteOpen(true)
    }

    const toggleQuestionSelection = (questionId: string, checked: boolean) => {
        setSelectedQuestionIds((prev) => {
            if (checked) return Array.from(new Set([...prev, questionId]))
            return prev.filter((id) => id !== questionId)
        })
    }

    const handleSelectAllQuestions = (checked: boolean) => {
        if (checked) {
            setSelectedQuestionIds(questions.map((q) => q.id))
            return
        }
        setSelectedQuestionIds([])
    }

    const confirmDeleteQuestion = async () => {
        const questionId = pendingDeleteId
        if (!questionId) {
            setConfirmDeleteOpen(false)
            return
        }
        setConfirmDeleteOpen(false)
        setPendingDeleteId(null)

        try {
            await ApiClient.deleteExamQuestion(examId, questionId)
            setQuestions(prev => prev.filter(q => q.id !== questionId))
            showSuccess('Question deleted successfully')
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to delete question')
        }
    }

    const confirmBulkDeleteQuestions = async () => {
        const toDelete = selectedQuestionIds.slice()
        if (toDelete.length === 0) {
            setConfirmBulkDeleteOpen(false)
            return
        }

        setBulkDeleting(true)
        setConfirmBulkDeleteOpen(false)
        setError(null)

        try {
            const results = await Promise.allSettled(
                toDelete.map((questionId) => ApiClient.deleteExamQuestion(examId, questionId))
            )
            const failed = results.filter((r) => r.status === 'rejected').length
            const deletedIds = toDelete.filter((_, idx) => results[idx]?.status === 'fulfilled')

            if (deletedIds.length > 0) {
                setQuestions((prev) => prev.filter((q) => !deletedIds.includes(q.id)))
            }
            setSelectedQuestionIds((prev) => prev.filter((id) => !deletedIds.includes(id)))

            if (failed > 0) {
                setError(`Bulk delete completed with ${failed} failure(s).`)
            }
            showSuccess(`Deleted ${deletedIds.length} question(s)`)
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to bulk delete questions')
        } finally {
            setBulkDeleting(false)
        }
    }

    const handleSaveQuestion = async (e: React.FormEvent) => {
        e.preventDefault()
        setSaving(true)
        setError(null)

        try {
            const normalizedQuestion =
                form.type === 'ESSAY'
                    ? form.question
                    : form.question.trim()
            const questionPlainText = stripRichTextToPlainText(normalizedQuestion)
            if (!questionPlainText) {
                throw new Error('Question text is required')
            }
            if (form.type === 'ESSAY' && form.gradingCriteria.length > 0 && gradingCriteriaPoints !== form.points) {
                throw new Error('The sum of key grading point scores must match the question points')
            }

            const hasCorrectAnswer =
                form.type === 'SINGLE_CHOICE' ||
                form.type === 'MULTIPLE_CHOICE' ||
                form.type === 'TRUE_FALSE' ||
                form.type === 'FILL_IN_BLANK'

            const normalizedOptions =
                form.type === 'SINGLE_CHOICE' || form.type === 'MULTIPLE_CHOICE'
                    ? form.options.map(o => o.trim())
                    : undefined
            if (normalizedOptions?.some((option) => !option)) {
                throw new Error('All answer options must contain text')
            }

            const payloadCorrectAnswer = (() => {
                if (!hasCorrectAnswer) return undefined
                if (form.type === 'MULTIPLE_CHOICE') {
                    if (!form.multiCorrectAnswers.length) {
                        throw new Error('Please select at least one correct option')
                    }
                    return form.multiCorrectAnswers.join(',')
                }
                if ((form.type === 'SINGLE_CHOICE' || form.type === 'TRUE_FALSE' || form.type === 'FILL_IN_BLANK') && !form.correctAnswer) {
                    throw new Error('Please select a correct answer')
                }
                return form.correctAnswer
            })()

            const payload = {
                type: form.type,
                question: normalizedQuestion,
                options: normalizedOptions,
                correctAnswer: payloadCorrectAnswer,
                explanation: form.explanation || undefined,
                points: form.points,
                difficulty: form.difficulty,
                maxWords: form.type === 'ESSAY' ? form.maxWords : undefined,
                rubric: form.type === 'ESSAY' ? form.rubric : undefined,
                sampleAnswer: form.type === 'ESSAY' ? form.sampleAnswer : undefined,
                gradingCriteria:
                    form.type === 'ESSAY'
                        ? form.gradingCriteria
                        : editingQuestion?.gradingCriteria?.length
                            ? null
                            : undefined,
                attachmentS3Key:
                    form.type === 'ESSAY'
                        ? form.attachmentS3Key || undefined
                        : editingQuestion?.attachmentS3Key
                            ? null
                            : undefined,
                attachmentFilename:
                    form.type === 'ESSAY'
                        ? form.attachmentFilename || undefined
                        : editingQuestion?.attachmentFilename
                            ? null
                            : undefined,
                attachmentMimeType:
                    form.type === 'ESSAY'
                        ? form.attachmentMimeType || undefined
                        : editingQuestion?.attachmentMimeType
                            ? null
                            : undefined,
            }

            let savedQuestion: ExamQuestion
            if (editingQuestion) {
                const response = await ApiClient.updateExamQuestion(examId, editingQuestion.id, payload)
                savedQuestion = response.data
            } else {
                const response = await ApiClient.createExamQuestion(examId, payload)
                savedQuestion = response.data
            }

            if (form.type === 'ESSAY' && attachmentFile) {
                try {
                    const attachmentPayload = await uploadEssayAttachment(savedQuestion.id, attachmentFile)
                    const attachmentResponse = await ApiClient.updateExamQuestion(examId, savedQuestion.id, {
                        type: 'ESSAY',
                        ...attachmentPayload,
                    })
                    savedQuestion = attachmentResponse.data
                } catch (uploadError) {
                    setQuestions(prev => {
                        const exists = prev.some(q => q.id === savedQuestion.id)
                        return exists ? prev.map(q => q.id === savedQuestion.id ? savedQuestion : q) : [...prev, savedQuestion]
                    })
                    setEditingQuestion(savedQuestion)
                    setForm({
                        type: savedQuestion.type,
                        question: savedQuestion.question,
                        options: normalizeEditorOptions(savedQuestion.options),
                        correctAnswer: savedQuestion.correctAnswer || '',
                        multiCorrectAnswers: savedQuestion.correctAnswer
                            ? savedQuestion.correctAnswer.split(',').map(s => s.trim()).filter(Boolean)
                            : [],
                        explanation: savedQuestion.explanation || '',
                        points: savedQuestion.points,
                        difficulty: (savedQuestion.difficulty as 'EASY' | 'MEDIUM' | 'HARD') || 'MEDIUM',
                        maxWords: savedQuestion.maxWords || undefined,
                        rubric: savedQuestion.rubric || undefined,
                        sampleAnswer: savedQuestion.sampleAnswer || undefined,
                        gradingCriteria: savedQuestion.gradingCriteria || [],
                        attachmentS3Key: savedQuestion.attachmentS3Key || undefined,
                        attachmentFilename: savedQuestion.attachmentFilename || undefined,
                        attachmentMimeType: savedQuestion.attachmentMimeType || undefined,
                        attachmentUrl: savedQuestion.attachmentUrl || undefined,
                    })
                    setShowForm(true)
                    throw new Error(
                        uploadError instanceof Error
                            ? `Question saved, but attachment upload failed: ${uploadError.message}`
                            : 'Question saved, but attachment upload failed'
                    )
                }
            }

            setQuestions(prev => {
                const exists = prev.some(q => q.id === savedQuestion.id)
                return exists ? prev.map(q => q.id === savedQuestion.id ? savedQuestion : q) : [...prev, savedQuestion]
            })
            showSuccess(editingQuestion ? 'Question updated successfully' : 'Question created successfully')
            closeQuestionForm()
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to save question')
        } finally {
            setSaving(false)
        }
    }

    const handleGenerateQuestions = async () => {
        if (sourceMode === 'single' && selectedLessonIds.length !== 1) {
            setError('Single VTT mode requires selecting exactly one lesson transcript source.')
            return
        }
        if (selectedLessonIds.length === 0) {
            setError('Select at least one lesson knowledge context to generate questions.')
            return
        }

        setGenerating(true)
        setError(null)

        try {
            const config = {
                questionCounts: {
                    singleChoice: generateConfig.singleChoice,
                    multipleChoice: generateConfig.multipleChoice,
                    trueFalse: generateConfig.trueFalse,
                    fillInBlank: generateConfig.fillInBlank,
                    essay: generateConfig.essay,
                },
                difficulty: generateConfig.difficulty,
                choiceOptionCount: generateConfig.choiceOptionCount,
                lessonIds: selectedLessonIds,
            }

            const response = await ApiClient.generateExamQuestions(examId, config)
            setQuestions(prev => [...prev, ...response.data])
            setShowGenerateDialog(false)
            showSuccess(`Generated ${response.data.length} questions successfully`)
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to generate questions')
        } finally {
            setGenerating(false)
        }
    }

    const showSuccess = (message: string) => {
        setSuccessMessage(message)
        setTimeout(() => setSuccessMessage(null), 3000)
    }

    const updateForm = <K extends keyof QuestionForm>(key: K, value: QuestionForm[K]) => {
        setForm(prev => ({ ...prev, [key]: value }))
    }

    const updateOption = (index: number, value: string) => {
        setForm(prev => ({
            ...prev,
            options: prev.options.map((o, i) => i === index ? value : o),
        }))
    }

    const addOption = () => {
        setForm((prev) => prev.options.length >= MAX_CHOICE_OPTIONS
            ? prev
            : { ...prev, options: [...prev.options, ''] })
    }

    const removeOption = (index: number) => {
        setForm((prev) => {
            if (prev.options.length <= MIN_CHOICE_OPTIONS) return prev

            const remapIndex = (value: string) => {
                const parsed = Number.parseInt(value, 10)
                if (!Number.isInteger(parsed)) return value
                if (parsed === index) return ''
                return parsed > index ? String(parsed - 1) : value
            }

            return {
                ...prev,
                options: prev.options.filter((_, optionIndex) => optionIndex !== index),
                correctAnswer: remapIndex(prev.correctAnswer),
                multiCorrectAnswers: prev.multiCorrectAnswers
                    .map(remapIndex)
                    .filter(Boolean),
            }
        })
    }

    const updateCriterion = <K extends keyof EssayGradingCriterion>(
        criterionId: string,
        field: K,
        value: EssayGradingCriterion[K]
    ) => {
        setForm((prev) => ({
            ...prev,
            gradingCriteria: prev.gradingCriteria.map((criterion) =>
                criterion.id === criterionId ? { ...criterion, [field]: value } : criterion
            ),
        }))
    }

    const addCriterion = () => {
        setForm((prev) => ({
            ...prev,
            gradingCriteria: [...prev.gradingCriteria, createEmptyCriterion()],
        }))
    }

    const removeCriterion = (criterionId: string) => {
        setForm((prev) => ({
            ...prev,
            gradingCriteria: prev.gradingCriteria.filter((criterion) => criterion.id !== criterionId),
        }))
    }

    const updateQuestionType = (nextType: ExamQuestionType) => {
        setForm(prev => ({
            ...prev,
            type: nextType,
            ...(nextType === 'ESSAY'
                ? {}
                : {
                    gradingCriteria: [],
                    attachmentS3Key: undefined,
                    attachmentFilename: undefined,
                    attachmentMimeType: undefined,
                    attachmentUrl: undefined,
                }),
        }))

        if (nextType !== 'ESSAY') {
            setAttachmentFile(null)
        }
    }

    const uploadEditorAsset = async (file: File) => {
        const contentType = resolveUploadedFileContentType(file)
        const uploadUrlResponse = await ApiClient.getAdminExamRichContentUploadUrl(examId, {
            filename: file.name,
            contentType,
        })

        const uploadResponse = await fetch(uploadUrlResponse.data.uploadUrl, {
            method: 'PUT',
            headers: {
                'Content-Type': contentType,
                'x-amz-server-side-encryption': 'AES256',
            },
            body: file,
        })

        if (!uploadResponse.ok) {
            throw new Error(`Failed to upload file (${uploadResponse.status})`)
        }

        return {
            url: uploadUrlResponse.data.accessUrl,
            name: file.name,
            assetKey: uploadUrlResponse.data.key,
        }
    }

    const uploadEssayAttachment = async (questionId: string, file: File) => {
        const contentType = resolveUploadedFileContentType(file)

        const uploadUrlResponse = await ApiClient.getAdminExamQuestionAttachmentUploadUrl(examId, questionId, {
            filename: file.name,
            contentType,
        })

        const uploadResponse = await fetch(uploadUrlResponse.data.uploadUrl, {
            method: 'PUT',
            headers: {
                'Content-Type': contentType,
                'x-amz-server-side-encryption': 'AES256',
            },
            body: file,
        })

        if (!uploadResponse.ok) {
            throw new Error(`Failed to upload essay attachment (${uploadResponse.status})`)
        }

        return {
            attachmentS3Key: uploadUrlResponse.data.key,
            attachmentFilename: file.name,
            attachmentMimeType: contentType,
        }
    }

    if (loading) {
        return (
            <DashboardLayout>
                <div className="flex items-center justify-center py-12">
                    <Loader2 className="h-8 w-8 animate-spin text-primary" />
                </div>
            </DashboardLayout>
        )
    }

    if (!exam) {
        return (
            <DashboardLayout>
                <div className="text-center py-12">
                    <p className="text-muted-foreground">Exam not found</p>
                    <Link href={isSmeMode ? '/sme/training-ops/exams' : '/admin/exams'}>
                        <Button className="mt-4">Back to Exams</Button>
                    </Link>
                </div>
            </DashboardLayout>
        )
    }

    const totalPoints = questions.reduce((sum, q) => sum + q.points, 0)
    const gradingCriteriaPoints = form.gradingCriteria.reduce((sum, criterion) => sum + criterion.maxPoints, 0)
    const canEditQuestions = exam.status === 'DRAFT'
    const allSelected = questions.length > 0 && selectedQuestionIds.length === questions.length
    const hasSelection = selectedQuestionIds.length > 0

    const formatQuestionAnswer = (question: ExamQuestion) => {
        if ((question.type === 'SINGLE_CHOICE' || question.type === 'MULTIPLE_CHOICE') && question.options) {
            const indexes = (question.correctAnswer || '')
                .split(',')
                .map(part => Number.parseInt(part.trim(), 10))
                .filter(idx => Number.isFinite(idx))

            if (!indexes.length) return question.correctAnswer || '(missing)'

            const formatted = indexes.map(idx => {
                const optionText = question.options?.[idx]?.trim()
                const optionLabel = String.fromCharCode(65 + idx)
                return optionText ? `${optionLabel}. ${optionText}` : `${optionLabel}`
            })

            return formatted.join(', ')
        }

        if (question.type === 'TRUE_FALSE') {
            if (question.correctAnswer === 'true') return 'True'
            if (question.correctAnswer === 'false') return 'False'
            return question.correctAnswer || '(missing)'
        }

        if (question.type === 'FILL_IN_BLANK') {
            return question.correctAnswer || '(missing)'
        }

        if (question.type === 'ESSAY') {
            return question.sampleAnswer || '(sample answer missing)'
        }

        return question.type === 'EXERCISE' ? 'Manual review (exercise recording)' : question.correctAnswer || '(missing)'
    }

    const buildAnswerKeyText = () => {
        return questions
            .map((question, index) => {
                const lines = [
                    `Q${index + 1}. [${questionTypeLabels[question.type]}] ${stripRichTextToPlainText(question.question)}`,
                    `Answer: ${formatQuestionAnswer(question)}`,
                ]
                if (question.type === 'ESSAY' && question.gradingCriteria?.length) {
                    lines.push(
                        `Key Grading Points: ${question.gradingCriteria
                            .map((criterion) => `${criterion.title} (${criterion.maxPoints})`)
                            .join('; ')}`
                    )
                }
                if (question.type === 'ESSAY' && question.rubric) {
                    lines.push(`Rubric: ${question.rubric}`)
                }
                if (question.explanation) {
                    lines.push(`Explanation: ${stripRichTextToPlainText(question.explanation)}`)
                }
                return lines.join('\n')
            })
            .join('\n\n')
    }

    const handleCopyAnswerKey = async () => {
        try {
            await navigator.clipboard.writeText(buildAnswerKeyText())
            showSuccess('Answer key copied')
        } catch {
            setError('Failed to copy answer key')
        }
    }

    const handleExportExamContent = async () => {
        try {
            setExportingContent(true)
            const blob = await ApiClient.exportExamContent(examId)
            const url = URL.createObjectURL(blob)
            const anchor = document.createElement('a')
            anchor.href = url
            anchor.download = `${exam?.title || 'exam-content'}.md`
            anchor.click()
            URL.revokeObjectURL(url)
            showSuccess('Exam content exported')
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to export exam content')
        } finally {
            setExportingContent(false)
        }
    }

    return (
        <DashboardLayout>
            <div className="space-y-6">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                        <BackButton fallbackHref={isSmeMode ? `/admin/exams/${examId}/edit?sme=1` : '/admin/exams'} />
                        <div>
                            <h1 className="text-3xl font-bold">Question Management</h1>
                            <p className="text-muted-foreground mt-1">{exam.title}</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        {!isSmeMode ? (
                            <Button
                                variant="outline"
                                onClick={handleExportExamContent}
                                disabled={exportingContent || questions.length === 0}
                            >
                                {exportingContent ? (
                                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                ) : (
                                    <Download className="h-4 w-4 mr-2" />
                                )}
                                Export Exam Content
                            </Button>
                        ) : null}
                        <Button
                            variant="destructive"
                            disabled={!canEditQuestions || !hasSelection || bulkDeleting}
                            onClick={() => setConfirmBulkDeleteOpen(true)}
                        >
                            {bulkDeleting ? (
                                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            ) : (
                                <Trash2 className="h-4 w-4 mr-2" />
                            )}
                            Delete Selected ({selectedQuestionIds.length})
                        </Button>
                        <Button variant="outline" onClick={() => setShowGenerateDialog(true)} disabled={!canEditQuestions}>
                            <Sparkles className="h-4 w-4 mr-2" />
                            Generate with AI
                        </Button>
                        <Button onClick={handleCreateQuestion} disabled={!canEditQuestions}>
                            <Plus className="h-4 w-4 mr-2" />
                            Add Question
                        </Button>
                    </div>
                </div>

                {!canEditQuestions && (
                    <div className="p-4 bg-amber-50 text-amber-800 rounded-lg">
                        This exam is read-only. Return it to Draft before modifying questions.
                    </div>
                )}

                {successMessage && (
                    <div className="p-4 bg-green-100 dark:bg-green-900/20 text-green-800 dark:text-green-200 rounded-lg flex items-center gap-2">
                        <CheckCircle className="h-4 w-4" />
                        {successMessage}
                    </div>
                )}

                {error && (
                    <div className="p-4 bg-destructive/10 text-destructive rounded-lg flex items-center gap-2">
                        <XCircle className="h-4 w-4" />
                        {error}
                        <Button variant="ghost" size="sm" onClick={() => setError(null)} className="ml-auto">
                            <X className="h-4 w-4" />
                        </Button>
                    </div>
                )}

                <div className="grid gap-4 md:grid-cols-3">
                    <Card>
                        <CardHeader className="pb-2">
                            <CardTitle className="text-sm font-medium">Total Questions</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="text-2xl font-bold">{questions.length}</div>
                        </CardContent>
                    </Card>
                    <Card>
                        <CardHeader className="pb-2">
                            <CardTitle className="text-sm font-medium">Total Points</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="text-2xl font-bold">{totalPoints} / {exam.totalScore}</div>
                            {totalPoints !== exam.totalScore && (
                                <p className="text-xs text-amber-600 mt-1">
                                    Points don&apos;t match exam total
                                </p>
                            )}
                        </CardContent>
                    </Card>
                    <Card>
                        <CardHeader className="pb-2">
                            <CardTitle className="text-sm font-medium">Question Types</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="flex flex-wrap gap-1">
                                {Object.entries(
                                    questions.reduce((acc, q) => {
                                        acc[q.type] = (acc[q.type] || 0) + 1
                                        return acc
                                    }, {} as Record<string, number>)
                                ).map(([type, count]) => (
                                    <Badge key={type} variant="secondary" className="text-xs">
                                        {questionTypeLabels[type as ExamQuestionType]}: {count}
                                    </Badge>
                                ))}
                            </div>
                        </CardContent>
                    </Card>
                </div>

                {/* Question Form */}
                {showForm && (
                    <Card ref={formRef}>
                        <CardHeader>
                            <div className="flex items-center justify-between">
                                <CardTitle>{editingQuestion ? 'Edit Question' : 'Add Question'}</CardTitle>
                                <Button variant="ghost" size="icon" onClick={closeQuestionForm}>
                                    <X className="h-4 w-4" />
                                </Button>
                            </div>
                        </CardHeader>
                        <CardContent>
                            <form onSubmit={handleSaveQuestion} className="space-y-4">
                                <div className="grid gap-4 md:grid-cols-3">
                                    <div className="space-y-2">
                                        <Label>Question Type</Label>
                                        <select
                                            className="w-full h-10 px-3 border rounded-md bg-background"
                                            value={form.type}
                                            onChange={(e) => updateQuestionType(e.target.value as ExamQuestionType)}
                                        >
                                            <option value="SINGLE_CHOICE">Single Choice</option>
                                            <option value="MULTIPLE_CHOICE">Multiple Choice</option>
                                            <option value="TRUE_FALSE">True/False</option>
                                            <option value="FILL_IN_BLANK">Fill in Blank</option>
                                            <option value="ESSAY">Essay</option>
                                            <option value="EXERCISE">Exercise (Screen Recording)</option>
                                        </select>
                                    </div>
                                    <div className="space-y-2">
                                        <Label>Points</Label>
                                        <Input
                                            type="number"
                                            min={1}
                                            value={form.points}
                                            onChange={(e) => updateForm('points', parseInt(e.target.value) || 1)}
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label>Difficulty</Label>
                                        <select
                                            className="w-full h-10 px-3 border rounded-md bg-background"
                                            value={form.difficulty}
                                            onChange={(e) => updateForm('difficulty', e.target.value as 'EASY' | 'MEDIUM' | 'HARD')}
                                        >
                                            <option value="EASY">Easy</option>
                                            <option value="MEDIUM">Medium</option>
                                            <option value="HARD">Hard</option>
                                        </select>
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <Label>Question *</Label>
                                    {form.type === 'ESSAY' ? (
                                        <RichTextEditor
                                            value={form.question}
                                            onChange={(value) => updateForm('question', value)}
                                            placeholder="Write the essay prompt with paragraphs, lists, emphasis, and links..."
                                            onUploadImage={uploadEditorAsset}
                                            onUploadFile={uploadEditorAsset}
                                        />
                                    ) : (
                                        <Textarea
                                            value={form.question}
                                            onChange={(e) => updateForm('question', e.target.value)}
                                            rows={3}
                                            required
                                        />
                                    )}
                                </div>

                                {(form.type === 'SINGLE_CHOICE' || form.type === 'MULTIPLE_CHOICE') && (
                                    <div className="space-y-2">
                                        <Label>Options</Label>
                                        {form.options.map((option, index) => (
                                            <div key={index} className="flex items-center gap-2">
                                                <span className="w-6 text-center font-medium">
                                                    {String.fromCharCode(65 + index)}.
                                                </span>
                                                <Input
                                                    value={option}
                                                    onChange={(e) => updateOption(index, e.target.value)}
                                                    placeholder={`Option ${String.fromCharCode(65 + index)}`}
                                                />
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    size="icon"
                                                    className="h-9 w-9 shrink-0"
                                                    disabled={form.options.length <= MIN_CHOICE_OPTIONS}
                                                    onClick={() => removeOption(index)}
                                                    aria-label={`Remove option ${String.fromCharCode(65 + index)}`}
                                                    title={`Remove option ${String.fromCharCode(65 + index)}`}
                                                >
                                                    <Trash2 className="h-4 w-4" />
                                                </Button>
                                            </div>
                                        ))}
                                        <div className="flex items-center justify-between gap-3 pt-1">
                                            <p className="text-xs text-muted-foreground">
                                                {form.options.length} options · labels A-{String.fromCharCode(64 + form.options.length)}
                                            </p>
                                            <Button
                                                type="button"
                                                variant="outline"
                                                size="sm"
                                                disabled={form.options.length >= MAX_CHOICE_OPTIONS}
                                                onClick={addOption}
                                            >
                                                <Plus className="mr-2 h-4 w-4" />
                                                Add option
                                            </Button>
                                        </div>
                                    </div>
                                )}

                                {(form.type === 'SINGLE_CHOICE' || form.type === 'MULTIPLE_CHOICE' || form.type === 'TRUE_FALSE' || form.type === 'FILL_IN_BLANK') && (
                                    <div className="space-y-2">
                                        <Label>Correct Answer *</Label>
                                        {form.type === 'SINGLE_CHOICE' ? (
                                            <div className="space-y-2">
                                                {form.options.map((option, index) => (
                                                    option.trim() && (
                                                        <label key={index} className="flex items-center gap-2">
                                                            <input
                                                                type="radio"
                                                                name="single-correct"
                                                                value={index.toString()}
                                                                checked={form.correctAnswer === index.toString()}
                                                                onChange={(e) => updateForm('correctAnswer', e.target.value)}
                                                                required
                                                            />
                                                            <span>{String.fromCharCode(65 + index)}. {option}</span>
                                                        </label>
                                                    )
                                                ))}
                                            </div>
                                        ) : form.type === 'MULTIPLE_CHOICE' ? (
                                            <div className="space-y-2">
                                                {form.options.map((option, index) => (
                                                    option.trim() && (
                                                        <label key={index} className="flex items-center gap-2">
                                                            <input
                                                                type="checkbox"
                                                                value={index.toString()}
                                                                checked={form.multiCorrectAnswers.includes(index.toString())}
                                                                onChange={(e) => {
                                                                    const value = e.target.value
                                                                    setForm(prev => {
                                                                        const exists = prev.multiCorrectAnswers.includes(value)
                                                                        const next = exists
                                                                            ? prev.multiCorrectAnswers.filter(v => v !== value)
                                                                            : [...prev.multiCorrectAnswers, value]
                                                                        return { ...prev, multiCorrectAnswers: next }
                                                                    })
                                                                }}
                                                            />
                                                            <span>{String.fromCharCode(65 + index)}. {option}</span>
                                                        </label>
                                                    )
                                                ))}
                                                <p className="text-xs text-muted-foreground">Select one or more correct options.</p>
                                            </div>
                                        ) : form.type === 'TRUE_FALSE' ? (
                                            <select
                                                className="w-full h-10 px-3 border rounded-md bg-background"
                                                value={form.correctAnswer}
                                                onChange={(e) => updateForm('correctAnswer', e.target.value)}
                                                required
                                            >
                                                <option value="">Select...</option>
                                                <option value="true">True</option>
                                                <option value="false">False</option>
                                            </select>
                                        ) : (
                                            <Input
                                                value={form.correctAnswer}
                                                onChange={(e) => updateForm('correctAnswer', e.target.value)}
                                                placeholder="Enter the correct answer"
                                                required
                                            />
                                        )}
                                    </div>
                                )}

                                {form.type === 'ESSAY' && (
                                    <>
                                        <div className="space-y-2">
                                            <Label>Reference Document (optional)</Label>
                                            <Input
                                                type="file"
                                                onChange={(e) => setAttachmentFile(e.target.files?.[0] ?? null)}
                                            />
                                            <p className="text-xs text-muted-foreground">
                                                Upload any file learners should reference while answering, including archives, images, or documents.
                                            </p>
                                            {(attachmentFile || form.attachmentFilename) && (
                                                <div className="rounded-md border bg-muted/30 p-3 text-sm space-y-2">
                                                    <div className="flex items-center gap-2 font-medium">
                                                        <Paperclip className="h-4 w-4" />
                                                        <span>{attachmentFile ? `New file: ${attachmentFile.name}` : form.attachmentFilename}</span>
                                                    </div>
                                                    {attachmentFile && form.attachmentFilename && (
                                                        <p className="text-xs text-muted-foreground">
                                                            Saving will replace the current attachment.
                                                        </p>
                                                    )}
                                                    {!attachmentFile && form.attachmentUrl && (
                                                        <a
                                                            href={form.attachmentUrl}
                                                            target="_blank"
                                                            rel="noreferrer"
                                                            className="inline-flex items-center gap-1 text-primary hover:underline"
                                                        >
                                                            <ExternalLink className="h-3.5 w-3.5" />
                                                            View current attachment
                                                        </a>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                        <div className="space-y-2">
                                            <Label>Max Words (optional)</Label>
                                            <Input
                                                type="number"
                                                min={50}
                                                value={form.maxWords || ''}
                                                onChange={(e) => updateForm('maxWords', e.target.value ? parseInt(e.target.value) : undefined)}
                                                placeholder="e.g., 500"
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <Label>Grading Rubric</Label>
                                            <Textarea
                                                value={form.rubric || ''}
                                                onChange={(e) => updateForm('rubric', e.target.value)}
                                                rows={3}
                                                placeholder="Describe the grading criteria..."
                                            />
                                        </div>
                                        <div className="space-y-3">
                                            <div className="flex items-center justify-between">
                                                <div>
                                                    <Label>Key Grading Points</Label>
                                                    <p className="text-xs text-muted-foreground mt-1">
                                                        AI will score against these criteria first, then Admin confirms or adjusts the final score.
                                                    </p>
                                                </div>
                                                <Button type="button" variant="outline" size="sm" onClick={addCriterion}>
                                                    <Plus className="h-4 w-4 mr-2" />
                                                    Add Point
                                                </Button>
                                            </div>
                                            {form.gradingCriteria.length > 0 ? (
                                                <div className="space-y-3">
                                                    {form.gradingCriteria.map((criterion, index) => (
                                                        <div key={criterion.id} className="rounded-lg border p-4 space-y-3">
                                                            <div className="flex items-center justify-between gap-4">
                                                                <p className="text-sm font-medium">Point {index + 1}</p>
                                                                <Button
                                                                    type="button"
                                                                    variant="ghost"
                                                                    size="sm"
                                                                    onClick={() => removeCriterion(criterion.id)}
                                                                >
                                                                    <Trash2 className="h-4 w-4 mr-2" />
                                                                    Remove
                                                                </Button>
                                                            </div>
                                                            <div className="grid gap-3 md:grid-cols-[1fr_140px]">
                                                                <div className="space-y-2">
                                                                    <Label>Title</Label>
                                                                    <Input
                                                                        value={criterion.title}
                                                                        onChange={(e) => updateCriterion(criterion.id, 'title', e.target.value)}
                                                                        placeholder="e.g., Root cause identified correctly"
                                                                    />
                                                                </div>
                                                                <div className="space-y-2">
                                                                    <Label>Max Points</Label>
                                                                    <Input
                                                                        type="number"
                                                                        min={1}
                                                                        value={criterion.maxPoints}
                                                                        onChange={(e) =>
                                                                            updateCriterion(
                                                                                criterion.id,
                                                                                'maxPoints',
                                                                                Math.max(1, parseInt(e.target.value || '1', 10) || 1)
                                                                            )
                                                                        }
                                                                    />
                                                                </div>
                                                            </div>
                                                            <div className="space-y-2">
                                                                <Label>Description (optional)</Label>
                                                                <Textarea
                                                                    value={criterion.description || ''}
                                                                    onChange={(e) => updateCriterion(criterion.id, 'description', e.target.value)}
                                                                    rows={2}
                                                                    placeholder="What should the reviewer look for?"
                                                                />
                                                            </div>
                                                            <div className="space-y-2">
                                                                <Label>Scoring Guidance (optional)</Label>
                                                                <Textarea
                                                                    value={criterion.guidance || ''}
                                                                    onChange={(e) => updateCriterion(criterion.id, 'guidance', e.target.value)}
                                                                    rows={2}
                                                                    placeholder="How to distinguish full, partial, and zero credit."
                                                                />
                                                            </div>
                                                            <label className="flex items-center gap-2 text-sm">
                                                                <input
                                                                    type="checkbox"
                                                                    checked={criterion.required || false}
                                                                    onChange={(e) => updateCriterion(criterion.id, 'required', e.target.checked)}
                                                                />
                                                                Required point
                                                            </label>
                                                        </div>
                                                    ))}
                                                    <div
                                                        className={`rounded-md border px-3 py-2 text-sm ${
                                                            gradingCriteriaPoints === form.points
                                                                ? 'border-green-200 bg-green-50 text-green-700'
                                                                : 'border-amber-200 bg-amber-50 text-amber-700'
                                                        }`}
                                                    >
                                                        Criteria total: {gradingCriteriaPoints} / {form.points} points
                                                    </div>
                                                </div>
                                            ) : (
                                                <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                                                    No key grading points yet. AI can still fall back to the rubric, but structured points are recommended.
                                                </div>
                                            )}
                                        </div>
                                        <div className="space-y-2">
                                            <Label>Sample Answer</Label>
                                            <Textarea
                                                value={form.sampleAnswer || ''}
                                                onChange={(e) => updateForm('sampleAnswer', e.target.value)}
                                                rows={3}
                                                placeholder="Provide a sample ideal answer..."
                                            />
                                        </div>
                                    </>
                                )}

                                <div className="space-y-2">
                                    <Label>Explanation (shown after answering)</Label>
                                    <RichTextEditor
                                        value={form.explanation}
                                        onChange={(value) => updateForm('explanation', value)}
                                        placeholder="Explain why the answer is correct. Use paragraphs, lists, and links if needed..."
                                        onUploadImage={uploadEditorAsset}
                                        onUploadFile={uploadEditorAsset}
                                    />
                                </div>

                                <div className="flex items-center gap-2">
                                    <Button type="submit" disabled={saving}>
                                        {saving ? (
                                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                        ) : (
                                            <Save className="h-4 w-4 mr-2" />
                                        )}
                                        {editingQuestion ? 'Update' : 'Create'} Question
                                    </Button>
                                    <Button type="button" variant="outline" onClick={closeQuestionForm}>
                                        Cancel
                                    </Button>
                                </div>
                            </form>
                        </CardContent>
                    </Card>
                )}

                {/* AI Generation Dialog */}
                {showGenerateDialog && (
                    <Card>
                        <CardHeader>
                            <div className="flex items-center justify-between">
                                <div>
                                    <CardTitle className="flex items-center gap-2">
                                        <Sparkles className="h-5 w-5" />
                                        Generate Questions with AI
                                    </CardTitle>
                                    <CardDescription>
                                        Automatically generate questions based on course content
                                    </CardDescription>
                                </div>
                                <Button variant="ghost" size="icon" onClick={() => setShowGenerateDialog(false)}>
                                    <X className="h-4 w-4" />
                                </Button>
                            </div>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
                                <div className="space-y-2">
                                    <Label>Single Choice</Label>
                                    <Input
                                        type="number"
                                        min={0}
                                        value={generateConfig.singleChoice}
                                        onChange={(e) => setGenerateConfig(prev => ({ ...prev, singleChoice: parseInt(e.target.value) || 0 }))}
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label>Multiple Choice</Label>
                                    <Input
                                        type="number"
                                        min={0}
                                        value={generateConfig.multipleChoice}
                                        onChange={(e) => setGenerateConfig(prev => ({ ...prev, multipleChoice: parseInt(e.target.value) || 0 }))}
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label>True/False</Label>
                                    <Input
                                        type="number"
                                        min={0}
                                        value={generateConfig.trueFalse}
                                        onChange={(e) => setGenerateConfig(prev => ({ ...prev, trueFalse: parseInt(e.target.value) || 0 }))}
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label>Fill in Blank</Label>
                                    <Input
                                        type="number"
                                        min={0}
                                        value={generateConfig.fillInBlank}
                                        onChange={(e) => setGenerateConfig(prev => ({ ...prev, fillInBlank: parseInt(e.target.value) || 0 }))}
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label>Essay</Label>
                                    <Input
                                        type="number"
                                        min={0}
                                        value={generateConfig.essay}
                                        onChange={(e) => setGenerateConfig(prev => ({ ...prev, essay: parseInt(e.target.value) || 0 }))}
                                    />
                                </div>
                            </div>
                            <div className="space-y-2">
                                <Label>Difficulty</Label>
                                <select
                                    className="w-full h-10 px-3 border rounded-md bg-background"
                                    value={generateConfig.difficulty}
                                    onChange={(e) =>
                                        setGenerateConfig(prev => ({
                                            ...prev,
                                            difficulty: e.target.value as 'EASY' | 'MEDIUM' | 'HARD' | 'mixed',
                                        }))
                                    }
                                >
                                    <option value="mixed">Mixed</option>
                                    <option value="EASY">Easy</option>
                                    <option value="MEDIUM">Medium</option>
                                    <option value="HARD">Hard</option>
                                </select>
                            </div>

                            <div className="space-y-2">
                                <Label>Choice options</Label>
                                <select
                                    className="h-10 w-full rounded-md border bg-background px-3"
                                    value={generateConfig.choiceOptionCount}
                                    onChange={(e) =>
                                        setGenerateConfig((prev) => ({
                                            ...prev,
                                            choiceOptionCount: Number(e.target.value) as 4 | 5 | 6,
                                        }))
                                    }
                                >
                                    <option value={4}>4 options (A-D)</option>
                                    <option value={5}>5 options (A-E)</option>
                                    <option value={6}>6 options (A-F)</option>
                                </select>
                            </div>

                            <div className="space-y-2">
                                <Label>Source Mode</Label>
                                <select
                                    className="w-full h-10 px-3 border rounded-md bg-background"
                                    value={sourceMode}
                                    onChange={(e) => {
                                        const nextMode = e.target.value as 'single' | 'multiple'
                                        setSourceMode(nextMode)
                                        if (nextMode === 'single') {
                                            setSelectedLessonIds((prev) => (prev[0] ? [prev[0]] : []))
                                        }
                                    }}
                                >
                                    <option value="single">Single VTT (one lesson only)</option>
                                    <option value="multiple">Multiple VTTs (combine lessons)</option>
                                </select>
                            </div>

                            <div className="space-y-2">
                                <div className="flex items-center justify-between gap-2">
                                    <Label>Lesson VTT / knowledge contexts</Label>
                                    <div className="flex items-center gap-2">
                                        <Button
                                            type="button"
                                            size="sm"
                                            variant="outline"
                                            onClick={() =>
                                                setSelectedLessonIds(() => {
                                                    const readyIds = knowledgeLessons
                                                        .filter((l) => l.knowledgeStatus === 'READY')
                                                        .map((l) => l.lessonId)
                                                    return sourceMode === 'single' ? (readyIds[0] ? [readyIds[0]] : []) : readyIds
                                                })
                                            }
                                            disabled={knowledgeLessonsLoading || knowledgeLessons.length === 0}
                                        >
                                            Select READY
                                        </Button>
                                        <Button
                                            type="button"
                                            size="sm"
                                            variant="outline"
                                            onClick={() => {
                                                const firstReady = knowledgeLessons.find((l) => l.knowledgeStatus === 'READY')
                                                setSelectedLessonIds(firstReady ? [firstReady.lessonId] : [])
                                                setSourceMode('single')
                                            }}
                                            disabled={knowledgeLessonsLoading || knowledgeLessons.length === 0}
                                        >
                                            Single READY
                                        </Button>
                                        <Button
                                            type="button"
                                            size="sm"
                                            variant="outline"
                                            onClick={() => setSelectedLessonIds([])}
                                            disabled={knowledgeLessonsLoading || selectedLessonIds.length === 0}
                                        >
                                            Clear
                                        </Button>
                                    </div>
                                </div>

                                {knowledgeLessonsLoading && (
                                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                        Loading lesson knowledge contexts…
                                    </div>
                                )}

                                {!knowledgeLessonsLoading && knowledgeLessonsError && (
                                    <div className="text-sm text-red-600">{knowledgeLessonsError}</div>
                                )}

                                {!knowledgeLessonsLoading && !knowledgeLessonsError && knowledgeLessons.length === 0 && (
                                    <div className="text-sm text-muted-foreground">
                                        {exam.course
                                            ? "No lessons available for this exam’s linked course."
                                            : "This exam is not linked to a course. Select lesson knowledge contexts from any course (upload VTTs and generate XML first)."}
                                    </div>
                                )}

                                {!knowledgeLessonsLoading && !knowledgeLessonsError && knowledgeLessons.length > 0 && (
                                    <div className="max-h-56 overflow-y-auto rounded-md border p-2 space-y-1">
                                        {knowledgeLessons.map((lesson) => {
                                            const checked = selectedLessonIds.includes(lesson.lessonId)
                                            const status = lesson.knowledgeStatus
                                            const statusBadge =
                                                status === 'READY' ? (
                                                    <Badge className="bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-200">
                                                        <CheckCircle className="h-3 w-3 mr-1" />
                                                        READY
                                                    </Badge>
                                                ) : status === 'PROCESSING' ? (
                                                    <Badge variant="secondary">
                                                        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                                                        PROCESSING
                                                    </Badge>
                                                ) : status === 'FAILED' ? (
                                                    <Badge className="bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-200">
                                                        <XCircle className="h-3 w-3 mr-1" />
                                                        FAILED
                                                    </Badge>
                                                ) : (
                                                    <Badge variant="secondary">{status}</Badge>
                                                )

                                            return (
                                                <label
                                                    key={lesson.lessonId}
                                                    className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-accent/50 cursor-pointer"
                                                >
                                                    <input
                                                        type="checkbox"
                                                        className="h-4 w-4"
                                                        checked={checked}
                                                        onChange={(e) => {
                                                            const nextChecked = e.target.checked
                                                            setSelectedLessonIds((prev) => {
                                                                if (sourceMode === 'single') {
                                                                    return nextChecked ? [lesson.lessonId] : prev.filter((id) => id !== lesson.lessonId)
                                                                }
                                                                if (nextChecked) return Array.from(new Set([...prev, lesson.lessonId]))
                                                                return prev.filter((id) => id !== lesson.lessonId)
                                                            })
                                                        }}
                                                    />
                                                    <div className="min-w-0 flex-1">
                                                        <div className="flex items-center justify-between gap-2">
                                                            <div className="min-w-0">
                                                                <div className="text-sm font-medium truncate">
                                                                    {lesson.chapterTitle} · {lesson.lessonTitle}
                                                                </div>
                                                                <div className="text-xs text-muted-foreground truncate">
                                                                    VTT: {lesson.transcriptFilename || 'N/A'} ·{' '}
                                                                    Anchors: {lesson.anchorCount} · Transcript:{' '}
                                                                    {lesson.hasTranscript ? 'Yes' : 'No'}
                                                                    {lesson.processedAt ? ` · Updated: ${lesson.processedAt}` : null}
                                                                </div>
                                                            </div>
                                                            <div className="shrink-0">{statusBadge}</div>
                                                        </div>
                                                    </div>
                                                </label>
                                            )
                                        })}
                                    </div>
                                )}

                                {!knowledgeLessonsLoading && knowledgeLessons.length > 0 && (
                                    <div className="text-xs text-muted-foreground">
                                        Selected lessons: {selectedLessonIds.length}. {sourceMode === 'single' ? 'Single VTT mode uses exactly one lesson source.' : 'Multiple mode combines selected VTT sources.'} Lessons without READY knowledge may take longer (or fail) if the VTT transcript/XML context is missing.
                                    </div>
                                )}
                            </div>

                            <div className="flex items-center gap-2">
                                <Button onClick={handleGenerateQuestions} disabled={generating}>
                                    {generating ? (
                                        <>
                                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                            Generating...
                                        </>
                                    ) : (
                                        <>
                                            <Sparkles className="h-4 w-4 mr-2" />
                                            Generate Questions
                                        </>
                                    )}
                                </Button>
                                <Button variant="outline" onClick={() => setShowGenerateDialog(false)}>
                                    Cancel
                                </Button>
                            </div>
                        </CardContent>
                    </Card>
                )}

                {essayScoringOverview.totalEssayQuestions > 0 && (
                    <Card className="border-slate-200 bg-[linear-gradient(180deg,#fcfdfd_0%,#f6f9fb_100%)] shadow-sm">
                        <CardHeader>
                            <div className="flex items-start justify-between gap-3">
                                <div>
                                    <CardTitle>Essay Scoring Health</CardTitle>
                                    <CardDescription>
                                        Visual check for structured scoring points, sample answers, and point balance before AI-assisted grading.
                                    </CardDescription>
                                </div>
                                <Badge
                                    variant="outline"
                                    className={`rounded-full ${essayHealthTheme[essayScoringOverview.readiness].badge}`}
                                >
                                    {essayScoringOverview.readiness}
                                </Badge>
                            </div>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className={`rounded-2xl border p-4 ${essayHealthTheme[essayScoringOverview.readiness].shell}`}>
                                <p className="text-sm font-semibold text-slate-950">
                                    {essayScoringOverview.readiness === 'READY'
                                        ? 'All essay questions are aligned for AI-assisted grading.'
                                        : essayScoringOverview.readiness === 'PARTIAL'
                                            ? `${essayScoringOverview.readyCount} of ${essayScoringOverview.totalEssayQuestions} essay questions are fully AI-ready.`
                                            : `${essayScoringOverview.readyCount} of ${essayScoringOverview.totalEssayQuestions} essay questions are AI-ready.`}
                                </p>
                                <p className="mt-2 text-sm leading-6 text-slate-600">
                                    READY means the question has structured scoring points, a sample answer, and matching point totals.
                                </p>
                            </div>
                            <div className="grid gap-3 md:grid-cols-5">
                                <div className="rounded-2xl border border-slate-200 bg-white p-4">
                                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Essay Questions</p>
                                    <p className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-slate-950">{essayScoringOverview.totalEssayQuestions}</p>
                                </div>
                                <div className="rounded-2xl border border-emerald-200 bg-emerald-50/80 p-4">
                                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-700">AI-ready</p>
                                    <p className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-emerald-900">{essayScoringOverview.readyCount}</p>
                                </div>
                                <div className="rounded-2xl border border-amber-200 bg-amber-50/80 p-4">
                                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-700">Missing points</p>
                                    <p className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-amber-900">
                                        {essayScoringOverview.missingCriteriaCount + essayScoringOverview.needsSetupCount}
                                    </p>
                                </div>
                                <div className="rounded-2xl border border-orange-200 bg-orange-50/80 p-4">
                                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-orange-700">Missing sample</p>
                                    <p className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-orange-900">
                                        {essayScoringOverview.missingSampleCount + essayScoringOverview.needsSetupCount}
                                    </p>
                                </div>
                                <div className="rounded-2xl border border-rose-200 bg-rose-50/80 p-4">
                                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-rose-700">Point mismatches</p>
                                    <p className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-rose-900">{essayScoringOverview.pointsMismatchCount}</p>
                                </div>
                            </div>
                            <div className="grid gap-3 lg:grid-cols-2">
                                {essayScoringOverview.details.map(({ question, readiness, detailLabel, criteriaCount, criteriaPoints, hasSampleAnswer }) => {
                                    const theme = essayHealthTheme[readiness]
                                    return (
                                        <div key={`essay-health-${question.id}`} className={`rounded-2xl border p-4 ${theme.shell}`}>
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="min-w-0">
                                                    <p className="text-sm font-semibold text-slate-950">
                                                        {stripRichTextToPlainText(question.question) || 'Untitled essay question'}
                                                    </p>
                                                    <p className="mt-1 text-xs text-slate-500">
                                                        {criteriaCount} scoring point{criteriaCount === 1 ? '' : 's'} · {criteriaPoints}/{question.points} pts · {hasSampleAnswer ? 'sample answer ready' : 'sample answer missing'}
                                                    </p>
                                                    <p className={`mt-2 text-xs font-medium ${theme.text}`}>
                                                        {detailLabel}
                                                    </p>
                                                </div>
                                                <Badge variant="outline" className={`rounded-full ${theme.badge}`}>
                                                    {readiness}
                                                </Badge>
                                            </div>
                                        </div>
                                    )
                                })}
                            </div>
                        </CardContent>
                    </Card>
                )}

                {/* Questions List */}
                <Card>
                    <CardHeader>
                        <div className="flex items-center justify-between gap-2">
                            <div>
                                <CardTitle>Questions ({questions.length})</CardTitle>
                                <CardDescription>Manage exam questions</CardDescription>
                            </div>
                            {questions.length > 0 && (
                                <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
                                    <input
                                        type="checkbox"
                                        className="h-4 w-4"
                                        checked={allSelected}
                                        onChange={(e) => handleSelectAllQuestions(e.target.checked)}
                                        disabled={!canEditQuestions}
                                    />
                                    Select All
                                </label>
                            )}
                        </div>
                    </CardHeader>
                    <CardContent>
                        {questions.length === 0 ? (
                            <div className="text-center py-12">
                                <p className="text-muted-foreground mb-4">
                                    No questions yet. Add questions manually or generate them with AI.
                                </p>
                                <div className="flex items-center justify-center gap-2">
                                    <Button variant="outline" onClick={() => setShowGenerateDialog(true)} disabled={!canEditQuestions}>
                                        <Sparkles className="h-4 w-4 mr-2" />
                                        Generate with AI
                                    </Button>
                                    <Button onClick={handleCreateQuestion} disabled={!canEditQuestions}>
                                        <Plus className="h-4 w-4 mr-2" />
                                        Add Question
                                    </Button>
                                </div>
                            </div>
                        ) : (
                            <div className="space-y-4">
                                {questions.map((question, index) => (
                                    <div
                                        key={question.id}
                                        className={`flex items-start gap-4 rounded-2xl border p-4 transition-colors hover:bg-accent/50 ${
                                            question.type === 'ESSAY'
                                                ? essayHealthTheme[getEssayQuestionHealth(question).readiness].shell
                                                : ''
                                        }`}
                                    >
                                        <input
                                            type="checkbox"
                                            className="mt-1 h-4 w-4"
                                            checked={selectedQuestionIds.includes(question.id)}
                                            onChange={(e) => toggleQuestionSelection(question.id, e.target.checked)}
                                            disabled={!canEditQuestions}
                                        />
                                        <div className="flex items-center gap-2 text-muted-foreground">
                                            <GripVertical className="h-4 w-4" />
                                            <span className="font-mono text-sm">{index + 1}</span>
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2 mb-2">
                                                <Badge variant="outline">
                                                    {questionTypeLabels[question.type]}
                                                </Badge>
                                                <Badge variant="secondary">
                                                    {question.points} pts
                                                </Badge>
                                                {question.type === 'ESSAY' && (() => {
                                                    const essayHealth = getEssayQuestionHealth(question)
                                                    const theme = essayHealthTheme[essayHealth.readiness]
                                                    return (
                                                        <div className="flex items-center gap-2">
                                                            <Badge variant="outline" className={`rounded-full ${theme.badge}`}>
                                                                {essayHealth.readiness}
                                                            </Badge>
                                                            <span className={`text-xs font-medium ${theme.text}`}>
                                                                {essayHealth.detailLabel}
                                                            </span>
                                                        </div>
                                                    )
                                                })()}
                                                {question.difficulty && (
                                                    <span className={`px-2 py-0.5 rounded text-xs ${difficultyColors[question.difficulty]}`}>
                                                        {question.difficulty}
                                                    </span>
                                                )}
                                            </div>
                                            {question.type === 'ESSAY' ? (
                                                <p className="text-sm line-clamp-2">{stripRichTextToPlainText(question.question)}</p>
                                            ) : (
                                                <p className="text-sm line-clamp-2">{question.question}</p>
                                            )}
                                            {question.type === 'ESSAY' && question.gradingCriteria?.length ? (
                                                <div className="mt-2 flex flex-wrap gap-2">
                                                    {question.gradingCriteria.map((criterion) => (
                                                        <Badge key={criterion.id} variant="secondary" className="text-xs">
                                                            {criterion.title}: {criterion.maxPoints}
                                                        </Badge>
                                                    ))}
                                                </div>
                                            ) : null}
                                            {(question.type === 'SINGLE_CHOICE' || question.type === 'MULTIPLE_CHOICE') && question.options && (
                                                <div className="mt-2 text-xs text-muted-foreground">
                                                    Options: {question.options.filter(o => o).join(', ')}
                                                </div>
                                            )}
                                            {question.type === 'ESSAY' && question.attachmentFilename && (
                                                <div className="mt-2 text-xs text-muted-foreground flex items-center gap-2">
                                                    <Paperclip className="h-3.5 w-3.5" />
                                                    {question.attachmentUrl ? (
                                                        <a
                                                            href={question.attachmentUrl}
                                                            target="_blank"
                                                            rel="noreferrer"
                                                            className="inline-flex items-center gap-1 text-primary hover:underline"
                                                        >
                                                            {question.attachmentFilename}
                                                            <ExternalLink className="h-3 w-3" />
                                                        </a>
                                                    ) : (
                                                        <span>{question.attachmentFilename}</span>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                onClick={() => handleEditQuestion(question)}
                                                disabled={!canEditQuestions}
                                            >
                                                <Edit className="h-4 w-4" />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="text-red-500 hover:text-red-600"
                                                onClick={() => handleDeleteQuestion(question.id)}
                                                disabled={!canEditQuestions}
                                            >
                                                <Trash2 className="h-4 w-4" />
                                            </Button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </CardContent>
                </Card>

                {questions.length > 0 && (
                    <Card>
                        <CardHeader>
                            <div className="flex items-center justify-between gap-2">
                                <div>
                                    <CardTitle>Answer Key (Admin Only)</CardTitle>
                                    <CardDescription>Generated from current question set. This panel is only in Admin.</CardDescription>
                                </div>
                                <Button variant="outline" size="sm" onClick={handleCopyAnswerKey}>
                                    <Copy className="h-4 w-4 mr-2" />
                                    Copy
                                </Button>
                            </div>
                        </CardHeader>
                        <CardContent>
                            <div className="space-y-3">
                                {questions.map((question, index) => (
                                    <div key={`answer-key-${question.id}`} className="rounded-lg border p-3">
                                        <div className="text-sm font-medium">
                                            <span>Q{index + 1}.</span>
                                            {question.type === 'ESSAY' ? (
                                                <RichTextContent html={question.question} className="mt-2" />
                                            ) : (
                                                <span className="ml-1">{question.question}</span>
                                            )}
                                        </div>
                                        <div className="mt-1 text-xs text-muted-foreground">
                                            {questionTypeLabels[question.type]}
                                        </div>
                                        <div className="mt-2 text-sm">
                                            <span className="font-medium">Answer: </span>
                                            <span className="whitespace-pre-wrap">{formatQuestionAnswer(question)}</span>
                                        </div>
                                        {question.type === 'ESSAY' && question.rubric && (
                                            <div className="mt-2 text-sm">
                                                <span className="font-medium">Rubric: </span>
                                                <span className="whitespace-pre-wrap">{question.rubric}</span>
                                            </div>
                                        )}
                                        {question.type === 'ESSAY' && question.gradingCriteria?.length ? (
                                            <div className="mt-2 text-sm">
                                                <p className="font-medium">Key Grading Points:</p>
                                                <div className="mt-2 space-y-2">
                                                    {question.gradingCriteria.map((criterion) => (
                                                        <div key={criterion.id} className="rounded-md border bg-muted/30 p-2">
                                                            <div className="flex items-center justify-between gap-2">
                                                                <span className="font-medium">{criterion.title}</span>
                                                                <span>{criterion.maxPoints} pts</span>
                                                            </div>
                                                            {criterion.description ? (
                                                                <p className="mt-1 text-muted-foreground">{criterion.description}</p>
                                                            ) : null}
                                                            {criterion.guidance ? (
                                                                <p className="mt-1 text-muted-foreground">Guidance: {criterion.guidance}</p>
                                                            ) : null}
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        ) : null}
                                        {question.type === 'ESSAY' && question.attachmentFilename && (
                                            <div className="mt-2 text-sm">
                                                <span className="font-medium">Attachment: </span>
                                                {question.attachmentUrl ? (
                                                    <a
                                                        href={question.attachmentUrl}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                        className="inline-flex items-center gap-1 text-primary hover:underline"
                                                    >
                                                        {question.attachmentFilename}
                                                        <ExternalLink className="h-3.5 w-3.5" />
                                                    </a>
                                                ) : (
                                                    <span>{question.attachmentFilename}</span>
                                                )}
                                            </div>
                                        )}
                                        {question.explanation && (
                                            <div className="mt-2 text-sm">
                                                <span className="font-medium">Explanation: </span>
                                                <RichTextContent html={question.explanation} className="mt-1" />
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </CardContent>
                    </Card>
                )}
            </div>
            <ConfirmDialog
                open={confirmDeleteOpen}
                onOpenChange={(open) => {
                    setConfirmDeleteOpen(open)
                    if (!open) setPendingDeleteId(null)
                }}
                title="Delete question?"
                description="This action cannot be undone."
                confirmLabel="Delete"
                confirmVariant="destructive"
                onConfirm={confirmDeleteQuestion}
            />
            <ConfirmDialog
                open={confirmBulkDeleteOpen}
                onOpenChange={setConfirmBulkDeleteOpen}
                title="Delete selected questions?"
                description={`This will delete ${selectedQuestionIds.length} question(s). This action cannot be undone.`}
                confirmLabel="Delete All"
                confirmVariant="destructive"
                onConfirm={confirmBulkDeleteQuestions}
            />
        </DashboardLayout>
    )
}

export default function ExamQuestionsPage({ params }: PageProps) {
    return (
        <Suspense fallback={null}>
            <ExamQuestionsPageContent params={params} />
        </Suspense>
    )
}
