import prisma from '@/lib/prisma'

export class ProgressService {
    /**
     * Update lesson progress
     */
    static async updateLessonProgress(
        userId: string,
        lessonId: string,
        data: {
            watchedDuration: number
            lastTimestamp: number
            completed?: boolean
        }
    ) {
        // Get lesson to verify it exists
        const lesson = await prisma.lesson.findUnique({
            where: { id: lessonId },
            include: {
                chapter: {
                    select: {
                        courseId: true,
                    },
                },
            },
        })

        if (!lesson) {
            throw new Error('LESSON_NOT_FOUND')
        }

        // Check if user is enrolled in the course
        const enrollment = await prisma.enrollment.findUnique({
            where: {
                userId_courseId: {
                    userId,
                    courseId: lesson.chapter.courseId,
                },
            },
        })

        if (!enrollment) {
            throw new Error('NOT_ENROLLED')
        }

        // Upsert lesson progress
        const progress = await prisma.lessonProgress.upsert({
            where: {
                userId_lessonId: {
                    userId,
                    lessonId,
                },
            },
            update: {
                watchedDuration: data.watchedDuration,
                lastTimestamp: data.lastTimestamp,
                ...(data.completed !== undefined && {
                    completed: data.completed,
                    completedAt: data.completed ? new Date() : null,
                }),
            },
            create: {
                userId,
                lessonId,
                watchedDuration: data.watchedDuration,
                lastTimestamp: data.lastTimestamp,
                completed: data.completed ?? false,
                completedAt: data.completed ? new Date() : undefined,
            },
        })

        // Update course progress
        await this.updateCourseProgress(userId, lesson.chapter.courseId)

        return progress
    }

    /**
     * Calculate and update overall course progress
     */
    static async updateCourseProgress(userId: string, courseId: string) {
        // Get all lessons in the course
        const lessons = await prisma.lesson.findMany({
            where: {
                chapter: {
                    courseId,
                },
            },
            select: {
                id: true,
                duration: true,
                progress: {
                    where: { userId },
                    select: {
                        completed: true,
                        watchedDuration: true,
                    },
                    take: 1,
                },
            },
        })

        const totalLessons = lessons.length

        const completedLessons = lessons.reduce((count, lesson) => {
            return count + (lesson.progress[0]?.completed ? 1 : 0)
        }, 0)

        // Blended progress:
        // - completed lesson => 100% for that lesson
        // - otherwise partial credit by watchedDuration / lesson.duration
        const lessonCompletionUnits = lessons.reduce((sum, lesson) => {
            const lessonProgress = lesson.progress[0]
            if (!lessonProgress) return sum
            if (lessonProgress.completed) return sum + 1

            const lessonDuration = Math.max(0, lesson.duration || 0)
            if (lessonDuration <= 0) return sum

            const watchedRatio = lessonProgress.watchedDuration / lessonDuration
            return sum + Math.max(0, Math.min(1, watchedRatio))
        }, 0)

        const progress = totalLessons > 0 ? (lessonCompletionUnits / totalLessons) * 100 : 0
        const isCompleted = completedLessons === totalLessons && totalLessons > 0

        // Update enrollment
        await prisma.enrollment.update({
            where: {
                userId_courseId: {
                    userId,
                    courseId,
                },
            },
            data: {
                progress,
                status: isCompleted ? 'COMPLETED' : 'ACTIVE',
                completedAt: isCompleted ? new Date() : null,
                lastAccessedAt: new Date(),
            },
        })

        return { progress, completedLessons, totalLessons }
    }

    /**
     * Get course progress for user
     */
    static async getCourseProgress(userId: string, courseId: string) {
        const enrollment = await prisma.enrollment.findUnique({
            where: {
                userId_courseId: {
                    userId,
                    courseId,
                },
            },
        })

        if (!enrollment) {
            throw new Error('NOT_ENROLLED')
        }

        // Get all lessons with progress
        const lessons = await prisma.lesson.findMany({
            where: {
                chapter: {
                    courseId,
                },
            },
            include: {
                progress: {
                    where: {
                        userId,
                    },
                },
            },
            orderBy: [
                { chapter: { order: 'asc' } },
                { order: 'asc' },
            ],
        })

        const completedCount = lessons.filter(l => l.progress[0]?.completed).length

        return {
            courseId,
            overallProgress: enrollment.progress,
            completedLessons: completedCount,
            totalLessons: lessons.length,
            lessonProgress: lessons.map(l => ({
                lessonId: l.id,
                completed: l.progress[0]?.completed || false,
                watchedDuration: l.progress[0]?.watchedDuration || 0,
                lastTimestamp: l.progress[0]?.lastTimestamp || 0,
            })),
            enrollment,
        }
    }

    /**
     * Get overall progress overview for a user
     */
    static async getUserOverview(userId: string) {
        const [enrollments, watchedDurationAggregate, recentActivity, certificates] = await Promise.all([
            prisma.enrollment.findMany({
                where: { userId },
                include: {
                    course: {
                        select: {
                            id: true,
                            title: true,
                            slug: true,
                            thumbnail: true,
                            level: true,
                            category: true,
                            instructor: {
                                select: {
                                    name: true,
                                },
                            },
                        },
                    },
                },
                orderBy: [
                    {
                        lastAccessedAt: 'desc',
                    },
                    {
                        enrolledAt: 'desc',
                    },
                ],
            }),
            prisma.lessonProgress.aggregate({
                _sum: {
                    watchedDuration: true,
                },
                where: {
                    userId,
                },
            }),
            prisma.lessonProgress.findMany({
                where: { userId },
                include: {
                    lesson: {
                        select: {
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
                        },
                    },
                },
                orderBy: { updatedAt: 'desc' },
            }),
            prisma.certificate.findMany({
                where: { userId },
                orderBy: { issueDate: 'desc' },
            }),
        ])

        const totalEnrolled = enrollments.length
        const completedCourses = enrollments.filter(e => e.status === 'COMPLETED').length
        const inProgressCourses = totalEnrolled - completedCourses
        const avgProgress =
            totalEnrolled > 0
                ? Number((enrollments.reduce((sum, enrollment) => sum + enrollment.progress, 0) / totalEnrolled).toFixed(1))
                : 0

        const totalWatchedSeconds = watchedDurationAggregate._sum.watchedDuration ?? 0
        const hoursLearned = Number((totalWatchedSeconds / 3600).toFixed(1))

        const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
        const now = Date.now()
        const upcomingDeadlines = enrollments
            .filter(enrollment => enrollment.status !== 'COMPLETED')
            .map(enrollment => {
                const start = enrollment.enrolledAt ?? enrollment.lastAccessedAt ?? new Date()
                const deadline = new Date(start.getTime() + THIRTY_DAYS_MS)
                return {
                    courseId: enrollment.courseId,
                    title: enrollment.course.title,
                    slug: enrollment.course.slug,
                    deadline,
                    enrolledAt: enrollment.enrolledAt,
                    progress: Math.round(enrollment.progress),
                    status: enrollment.status,
                }
            })
            .filter(item => item.deadline.getTime() > now)
            .sort((a, b) => a.deadline.getTime() - b.deadline.getTime())

        const courseInfoById = new Map<
            string,
            {
                title: string
                instructorName?: string | null
            }
        >()
        enrollments.forEach(enrollment => {
            courseInfoById.set(enrollment.courseId, {
                title: enrollment.course.title,
                instructorName: enrollment.course.instructor?.name,
            })
        })

        const missingCourseIds = certificates
            .filter(cert => cert.courseId && !courseInfoById.has(cert.courseId))
            .map(cert => cert.courseId as string)

        if (missingCourseIds.length > 0) {
            const extraCourses = await prisma.course.findMany({
                where: { id: { in: missingCourseIds } },
                select: {
                    id: true,
                    title: true,
                    instructor: {
                        select: {
                            name: true,
                        },
                    },
                },
            })
            extraCourses.forEach(course => {
                courseInfoById.set(course.id, {
                    title: course.title,
                    instructorName: course.instructor?.name,
                })
            })
        }

        return {
            stats: {
                totalEnrolled,
                completedCourses,
                inProgressCourses,
                avgProgress,
                hoursLearned,
            },
            courses: enrollments.map(enrollment => ({
                courseId: enrollment.courseId,
                title: enrollment.course.title,
                slug: enrollment.course.slug,
                thumbnail: enrollment.course.thumbnail,
                instructorName: enrollment.course.instructor?.name ?? 'Instructor',
                progress: Math.round(enrollment.progress),
                status: enrollment.status,
                level: enrollment.course.level,
                category: enrollment.course.category,
                enrolledAt: enrollment.enrolledAt,
                lastAccessedAt: enrollment.lastAccessedAt,
                completedAt: enrollment.completedAt,
            })),
            recentActivity: recentActivity.map(activity => ({
                id: activity.id,
                lessonId: activity.lessonId,
                lessonTitle: activity.lesson?.title ?? 'Lesson',
                courseId: activity.lesson?.chapter.course.id,
                courseTitle: activity.lesson?.chapter.course.title ?? 'Course',
                completed: activity.completed,
                watchedDuration: activity.watchedDuration,
                updatedAt: activity.updatedAt,
            })),
            upcomingDeadlines,
            certificates: certificates.map(certificate => ({
                id: certificate.id,
                courseId: certificate.courseId,
                courseTitle: certificate.courseId
                    ? courseInfoById.get(certificate.courseId)?.title ?? 'Course'
                    : 'Course',
                instructorName: certificate.courseId
                    ? courseInfoById.get(certificate.courseId)?.instructorName ?? undefined
                    : undefined,
                certificateNumber: certificate.certificateNumber,
                issueDate: certificate.issueDate,
                pdfUrl: certificate.pdfUrl ?? undefined,
            })),
        }
    }
}
