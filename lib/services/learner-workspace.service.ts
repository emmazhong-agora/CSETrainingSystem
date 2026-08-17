import prisma from '@/lib/prisma'
import { ExamAttemptStatus, ExamStatus } from '@prisma/client'

export class LearnerWorkspaceService {
    static async getRewardsOverview(userId: string) {
        const [allStarAwards, recentStarAwards, badgeAwards, certificatesEarned, domainMilestones] = await Promise.all([
            prisma.starAward.findMany({
                where: { userId },
                include: {
                    domain: { select: { id: true, name: true, slug: true } },
                    event: { select: { id: true, title: true } },
                    exam: { select: { id: true, title: true } },
                },
                orderBy: { awardedAt: 'desc' },
            }),
            prisma.starAward.findMany({
                where: { userId },
                include: {
                    domain: { select: { id: true, name: true, slug: true } },
                    event: { select: { id: true, title: true } },
                    exam: { select: { id: true, title: true } },
                },
                orderBy: { awardedAt: 'desc' },
                take: 12,
            }),
            prisma.badgeAward.findMany({
                where: {
                    userId,
                    badge: {
                        is: {
                            domainId: { not: null },
                        },
                    },
                },
                include: {
                    badge: {
                        select: {
                            id: true,
                            name: true,
                            slug: true,
                            description: true,
                            icon: true,
                            thresholdStars: true,
                            domain: {
                                select: {
                                    id: true,
                                    name: true,
                                    slug: true,
                                },
                            },
                        },
                    },
                    domain: { select: { id: true, name: true, slug: true } },
                    event: { select: { id: true, title: true } },
                },
                orderBy: { awardedAt: 'desc' },
            }),
            prisma.certificate.count({
                where: { userId },
            }),
            prisma.badgeMilestone.findMany({
                where: {
                    active: true,
                    domainId: { not: null },
                },
                include: {
                    domain: {
                        select: {
                            id: true,
                            name: true,
                            slug: true,
                        },
                    },
                },
                orderBy: [
                    { domainId: 'asc' },
                    { thresholdStars: 'asc' },
                ],
            }),
        ])

        const totalStars = allStarAwards.reduce((sum, award) => sum + award.stars, 0)
        const totalBadges = badgeAwards.length
        const recognizedEvents = new Set(
            [...allStarAwards.map((award) => award.eventId), ...badgeAwards.map((award) => award.eventId)].filter(Boolean)
        ).size

        const domainMap = new Map<string, { domainId: string | null; domainName: string; stars: number; badges: number }>()

        for (const award of allStarAwards) {
            const key = award.domainId ?? 'global'
            const current = domainMap.get(key) ?? {
                domainId: award.domainId ?? null,
                domainName: award.domain?.name ?? 'General Training',
                stars: 0,
                badges: 0,
            }
            current.stars += award.stars
            domainMap.set(key, current)
        }

        for (const award of badgeAwards) {
            const key = award.domainId ?? 'global'
            const current = domainMap.get(key) ?? {
                domainId: award.domainId ?? null,
                domainName: award.domain?.name ?? 'General Training',
                stars: 0,
                badges: 0,
            }
            current.badges += 1
            domainMap.set(key, current)
        }

        const topDomains = Array.from(domainMap.values())
            .filter((item): item is { domainId: string; domainName: string; stars: number; badges: number } => Boolean(item.domainId))
            .sort((a, b) => {
                if (b.stars !== a.stars) return b.stars - a.stars
                return b.badges - a.badges
            })

        const domainStarTotals = new Map<string, number>()
        for (const award of allStarAwards) {
            if (!award.domainId) continue
            domainStarTotals.set(award.domainId, (domainStarTotals.get(award.domainId) ?? 0) + award.stars)
        }

        const earnedBadgeIdsByDomain = new Map<string, Set<string>>()
        for (const award of badgeAwards) {
            const domainId = award.domainId ?? award.badge.domain?.id
            if (!domainId) continue
            const ids = earnedBadgeIdsByDomain.get(domainId) ?? new Set<string>()
            ids.add(award.badge.id)
            earnedBadgeIdsByDomain.set(domainId, ids)
        }

        const milestonesByDomain = new Map<string, typeof domainMilestones>()
        for (const milestone of domainMilestones) {
            if (!milestone.domainId || !milestone.domain) continue
            const current = milestonesByDomain.get(milestone.domainId) ?? []
            current.push(milestone)
            milestonesByDomain.set(milestone.domainId, current)
        }

        const domainProgressions = Array.from(milestonesByDomain.entries()).map(([domainId, milestones]) => {
            const stars = domainStarTotals.get(domainId) ?? 0
            const earnedForDomain = earnedBadgeIdsByDomain.get(domainId) ?? new Set<string>()
            const currentBadge = [...milestones]
                .filter((milestone) => earnedForDomain.has(milestone.id) && milestone.thresholdStars <= stars)
                .sort((a, b) => b.thresholdStars - a.thresholdStars)[0] ?? null
            const nextDomainBadge = [...milestones]
                .find((milestone) => !earnedForDomain.has(milestone.id) && milestone.thresholdStars > stars) ?? null
            const maxThreshold = milestones[milestones.length - 1]?.thresholdStars ?? 0
            const progressBasis = (nextDomainBadge?.thresholdStars ?? maxThreshold) || 1

            return {
                domain: milestones[0].domain!,
                stars,
                unlockedBadges: earnedForDomain.size,
                currentBadge: currentBadge
                    ? {
                        id: currentBadge.id,
                        name: currentBadge.name,
                        slug: currentBadge.slug,
                        thresholdStars: currentBadge.thresholdStars,
                    }
                    : null,
                nextBadge: nextDomainBadge
                    ? {
                        id: nextDomainBadge.id,
                        name: nextDomainBadge.name,
                        slug: nextDomainBadge.slug,
                        thresholdStars: nextDomainBadge.thresholdStars,
                        remainingStars: Math.max(nextDomainBadge.thresholdStars - stars, 0),
                    }
                    : null,
                progressPercent: Math.max(0, Math.min(100, Math.round((stars / progressBasis) * 100))),
            }
        }).sort((a, b) => {
            if (b.stars !== a.stars) return b.stars - a.stars
            return a.domain.name.localeCompare(b.domain.name)
        })

        const nextBadge = [...domainProgressions]
            .filter((item) => item.nextBadge)
            .sort((a, b) => {
                const remainingDelta = (a.nextBadge?.remainingStars ?? Infinity) - (b.nextBadge?.remainingStars ?? Infinity)
                if (remainingDelta !== 0) return remainingDelta
                return a.domain.name.localeCompare(b.domain.name)
            })[0] ?? null

        return {
            summary: {
                totalStars,
                totalBadges,
                recognizedEvents,
                activeDomains: topDomains.length,
                certificatesEarned,
            },
            recentStarAwards: recentStarAwards.map((award) => ({
                id: award.id,
                stars: award.stars,
                sourceType: award.sourceType,
                reason: award.reason,
                awardedAt: award.awardedAt,
                domain: award.domain,
                event: award.event,
                exam: award.exam,
            })),
            badges: badgeAwards.map((award) => ({
                id: award.id,
                awardedAt: award.awardedAt,
                badge: award.badge,
                domain: award.domain,
                event: award.event,
            })),
            topDomains,
            domainProgressions,
            nextBadge: nextBadge
                ? {
                    id: nextBadge.nextBadge!.id,
                    name: nextBadge.nextBadge!.name,
                    slug: nextBadge.nextBadge!.slug,
                    thresholdStars: nextBadge.nextBadge!.thresholdStars,
                    remainingStars: nextBadge.nextBadge!.remainingStars,
                    domain: nextBadge.domain,
                }
                : null,
        }
    }

    static async getTrainingOverview(userId: string) {
        const [exams, recentAttempts] = await Promise.all([
            prisma.exam.findMany({
                where: {
                    status: ExamStatus.PUBLISHED,
                    invitations: {
                        some: { userId },
                    },
                },
                include: {
                    productDomain: {
                        select: { id: true, name: true, slug: true },
                    },
                    certificateTemplate: {
                        select: { isEnabled: true, title: true },
                    },
                    learningSeries: {
                        select: { id: true, name: true, slug: true, type: true },
                    },
                    learningEvent: {
                        select: {
                            id: true,
                            title: true,
                            format: true,
                            status: true,
                            scheduledAt: true,
                            isRequired: true,
                            createdAt: true,
                        },
                    },
                    invitations: {
                        where: { userId },
                        select: {
                            createdAt: true,
                            viewedAt: true,
                        },
                        take: 1,
                    },
                    attempts: {
                        where: { userId },
                        select: {
                            id: true,
                            attemptNumber: true,
                            status: true,
                            percentageScore: true,
                            passed: true,
                            submittedAt: true,
                        },
                        orderBy: { attemptNumber: 'desc' },
                    },
                },
                orderBy: [
                    { deadline: 'asc' },
                    { createdAt: 'desc' },
                ],
            }),
            prisma.examAttempt.findMany({
                where: {
                    userId,
                    status: {
                        in: [ExamAttemptStatus.SUBMITTED, ExamAttemptStatus.GRADED],
                    },
                },
                include: {
                    exam: {
                        select: {
                            id: true,
                            title: true,
                            assessmentKind: true,
                            productDomain: {
                                select: { name: true },
                            },
                            learningEvent: {
                                select: { title: true },
                            },
                        },
                    },
                },
                orderBy: [
                    { submittedAt: 'desc' },
                    { startedAt: 'desc' },
                ],
            }),
        ])

        const assignedExams = exams.map((exam) => {
            const completedAttempts = exam.attempts.filter(
                (attempt) => attempt.status === ExamAttemptStatus.SUBMITTED || attempt.status === ExamAttemptStatus.GRADED
            ).length
            const inProgressAttempt = exam.attempts.find((attempt) => attempt.status === ExamAttemptStatus.IN_PROGRESS)
            const bestAttempt = exam.attempts
                .filter((attempt) => attempt.percentageScore !== null)
                .sort((a, b) => (b.percentageScore ?? 0) - (a.percentageScore ?? 0))[0]
            const latestSubmittedAt = exam.attempts
                .map((attempt) => attempt.submittedAt)
                .filter((submittedAt): submittedAt is Date => submittedAt !== null)
                .sort((a, b) => b.getTime() - a.getTime())[0] ?? null
            const invitation = exam.invitations[0]

            return {
                id: exam.id,
                title: exam.title,
                status: exam.status,
                assessmentKind: exam.assessmentKind,
                countsTowardPerformance: exam.countsTowardPerformance,
                awardsStars: exam.awardsStars,
                starValue: exam.starValue,
                deadline: exam.deadline,
                availableFrom: exam.availableFrom,
                invitationCreatedAt: invitation?.createdAt ?? null,
                invitationViewedAt: invitation?.viewedAt ?? null,
                latestSubmittedAt,
                domain: exam.productDomain,
                learningSeries: exam.learningSeries,
                certificateEligible: exam.assessmentKind === 'FORMAL' && Boolean(exam.certificateTemplate?.isEnabled),
                learningEvent: exam.learningEvent
                    ? {
                        id: exam.learningEvent.id,
                        title: exam.learningEvent.title,
                        format: exam.learningEvent.format,
                        scheduledAt: exam.learningEvent.scheduledAt,
                        createdAt: exam.learningEvent.createdAt,
                        isRequired: exam.learningEvent.isRequired,
                    }
                    : null,
                userStatus: {
                    completedAttempts,
                    remainingAttempts: Math.max(exam.maxAttempts - completedAttempts, 0),
                    hasInProgressAttempt: Boolean(inProgressAttempt),
                    inProgressAttemptId: inProgressAttempt?.id,
                    bestScore: bestAttempt?.percentageScore ?? null,
                    hasPassed: exam.attempts.some((attempt) => attempt.passed === true),
                },
            }
        })

        const upcomingEventMap = new Map<string, {
            id: string
            title: string
            format: string
            status: string
            scheduledAt?: Date | null
            createdAt: Date
            isRequired: boolean
            domain?: { id: string; name: string; slug: string } | null
            linkedExams: Array<{ id: string; title: string; deadline?: Date | null }>
        }>()

        for (const exam of exams) {
            if (!exam.learningEvent) continue
            const existing = upcomingEventMap.get(exam.learningEvent.id) ?? {
                id: exam.learningEvent.id,
                title: exam.learningEvent.title,
                format: exam.learningEvent.format,
                status: exam.learningEvent.status,
                scheduledAt: exam.learningEvent.scheduledAt,
                createdAt: exam.learningEvent.createdAt,
                isRequired: exam.learningEvent.isRequired,
                domain: exam.productDomain,
                linkedExams: [],
            }
            existing.linkedExams.push({
                id: exam.id,
                title: exam.title,
                deadline: exam.deadline,
            })
            upcomingEventMap.set(exam.learningEvent.id, existing)
        }

        const now = Date.now()
        const upcomingEvents = Array.from(upcomingEventMap.values())
            .filter((event) => !event.scheduledAt || new Date(event.scheduledAt).getTime() >= now - 24 * 60 * 60 * 1000)
            .sort((a, b) => {
                const aTime = a.scheduledAt ? new Date(a.scheduledAt).getTime() : Number.MAX_SAFE_INTEGER
                const bTime = b.scheduledAt ? new Date(b.scheduledAt).getTime() : Number.MAX_SAFE_INTEGER
                return aTime - bTime
            })

        return {
            summary: {
                assignedExams: assignedExams.length,
                pendingExams: assignedExams.filter((exam) => !exam.userStatus.hasPassed && exam.userStatus.remainingAttempts > 0).length,
                inProgressExams: assignedExams.filter((exam) => exam.userStatus.hasInProgressAttempt).length,
                passedExams: assignedExams.filter((exam) => exam.userStatus.hasPassed).length,
                upcomingEvents: upcomingEvents.length,
                requiredItems: assignedExams.filter((exam) => exam.countsTowardPerformance || exam.learningEvent?.isRequired).length,
            },
            upcomingEvents,
            assignedExams,
            recentCompletions: recentAttempts.map((attempt) => ({
                attemptId: attempt.id,
                examId: attempt.examId,
                examTitle: attempt.exam.title,
                submittedAt: attempt.submittedAt,
                startedAt: attempt.startedAt,
                percentageScore: attempt.percentageScore,
                passed: attempt.passed,
                domainName: attempt.exam.productDomain?.name ?? null,
                eventTitle: attempt.exam.learningEvent?.title ?? null,
                assessmentKind: attempt.exam.assessmentKind,
            })),
        }
    }
}
