/**
 * User Exams Routes
 * GET /api/exams - List available exams for the user
 */

import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth-middleware';
import prisma from '@/lib/prisma';
import { ExamAttemptStatus, ExamStatus } from '@prisma/client';

// GET /api/exams - List exams available to the user
export const GET = withAuth(async (req: NextRequest, user) => {
  try {
    const { searchParams } = new URL(req.url);
    const courseId = searchParams.get('courseId');

    // Include current assignments plus the user's submitted history. Historical
    // attempts must remain visible after an exam is closed or archived.
    const exams = await prisma.exam.findMany({
      where: {
        AND: [
          // Filter by course if specified
          courseId ? { courseId } : {},
          {
            OR: [
              {
                status: { in: [ExamStatus.PUBLISHED, ExamStatus.CLOSED] },
                invitations: { some: { userId: user.id } },
              },
              {
                attempts: {
                  some: {
                    userId: user.id,
                    status: { in: [ExamAttemptStatus.SUBMITTED, ExamAttemptStatus.GRADED] },
                  },
                },
              },
            ],
          },
        ],
      },
      include: {
        course: {
          select: {
            id: true,
            title: true,
          },
        },
        productDomain: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
        certificateTemplate: {
          select: {
            isEnabled: true,
          },
        },
        _count: {
          select: {
            questions: true,
          },
        },
        attempts: {
          where: { userId: user.id },
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
    });

    // Transform to include user-specific status
    const examsWithStatus = exams.map(exam => {
      const completedAttempts = exam.attempts.filter(
        a => a.status === 'SUBMITTED' || a.status === 'GRADED'
      ).length;
      const inProgressAttempt = exam.attempts.find(a => a.status === 'IN_PROGRESS');
      const bestAttempt = exam.attempts
        .filter(a => a.percentageScore !== null)
        .sort((a, b) => (b.percentageScore || 0) - (a.percentageScore || 0))[0];

      return {
        id: exam.id,
        status: exam.status,
        title: exam.title,
        description: exam.description,
        assessmentKind: exam.assessmentKind,
        awardsStars: exam.awardsStars,
        starValue: exam.starValue,
        countsTowardPerformance: exam.countsTowardPerformance,
        certificateEligible: exam.assessmentKind === 'FORMAL' && Boolean(exam.certificateTemplate?.isEnabled),
        productDomainId: exam.productDomainId,
        productDomain: exam.productDomain,
        courseId: exam.courseId,
        course: exam.course,
        timeLimit: exam.timeLimit,
        totalScore: exam.totalScore,
        passingScore: exam.passingScore,
        maxAttempts: exam.maxAttempts,
        timezone: exam.timezone,
        availableFrom: exam.availableFrom,
        deadline: exam.deadline,
        createdAt: exam.createdAt,
        updatedAt: exam.updatedAt,
        questionCount: exam._count.questions,
        attemptResults: exam.attempts
          .filter(a => a.status === 'SUBMITTED' || a.status === 'GRADED')
          .map(a => ({
            id: a.id,
            attemptNumber: a.attemptNumber,
            status: a.status,
            percentageScore: a.percentageScore,
            passed: a.passed,
            submittedAt: a.submittedAt,
          })),
        // User status
        userStatus: {
          completedAttempts,
          remainingAttempts: exam.maxAttempts - completedAttempts,
          hasInProgressAttempt: !!inProgressAttempt,
          inProgressAttemptId: inProgressAttempt?.id,
          bestScore: bestAttempt?.percentageScore,
          hasPassed: exam.attempts.some(a => a.passed === true),
        },
      };
    });

    return NextResponse.json({
      success: true,
      data: examsWithStatus,
    });
  } catch (error) {
    console.error('List exams error:', error);
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'EXAM_001',
          message: 'Failed to list exams',
        },
      },
      { status: 500 }
    );
  }
});
