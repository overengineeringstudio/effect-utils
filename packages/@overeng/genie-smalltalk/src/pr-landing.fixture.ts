import {
  ciPassed,
  completed,
  fieldIs,
  humanGate,
  input,
  merged,
  mission,
  product,
  step,
  type Node,
} from './mod.ts'

/** Synthetic public flow: no credentials, deployment targets, or private subjects. */
export const prLanding = (): Node => {
  const pr = input.resource({ name: 'pr', kind: 'vcs.pull-request' })
  const commit = input.text('commit')
  const locator = input.text('locator')
  const owner = { kind: 'agent', id: 'team/worker' } as const
  const review = step({
    id: 'review',
    missionId: 'pr-landing',
    assignedTo: owner,
    goals: ['Review the exact PR input and publish the review report.'],
    produces: {
      report: product.resource({ kind: 'custom.garden.review', fields: { state: 'approved' } }),
    },
    gates: [
      fieldIs({ name: 'open-pr', subject: pr, path: 'state', value: 'open' }),
      humanGate({ name: 'review', reviewer: 'person/reviewer', review: [pr] }),
    ],
  })
  const ci = step({
    id: 'ci',
    missionId: 'pr-landing',
    assignedTo: owner,
    dependsOn: [completed(review)],
    goals: ['Verify CI for the supplied exact commit.'],
    gates: [
      fieldIs({
        name: 'reviewed',
        subject: review.products.report,
        path: 'state',
        value: 'approved',
      }),
      ciPassed({ name: 'build', check: 'build', repo: 'acme/garden', ref: { commit } }),
    ],
  })
  const land = step({
    id: 'land',
    missionId: 'pr-landing',
    assignedTo: owner,
    dependsOn: [completed(ci)],
    goals: ['Land the supplied PR and publish its landing receipt.'],
    produces: {
      receipt: product.field({
        subject: 'message/mission-run/${ST_MISSION_RUN}/land',
        fields: { text: 'The PR was landed.' },
      }),
    },
    gates: [merged({ name: 'merged', locator })],
  })
  return mission({
    id: 'pr-landing',
    state: 'ready',
    goals: ['Review, verify and land one exact PR.'],
    inputs: [pr, commit, locator],
    steps: [review, ci, land],
    gates: [
      fieldIs({
        name: 'receipt',
        subject: land.products.receipt,
        path: 'text',
        value: 'The PR was landed.',
      }),
    ],
  })
}

/** q60 alternative: bind the same source facts at config time, publishing a mission per PR. */
export const prLandingFragment = (pr: {
  readonly number: number
  readonly commit: string
}): Node => {
  const id = `pr-landing-${pr.number}`
  const subject = `resource/acme/garden/pr-${pr.number}`
  const owner = { kind: 'agent', id: 'team/worker' } as const
  const review = step({
    id: 'review',
    missionId: id,
    assignedTo: owner,
    goals: ['Review the exact PR input and publish the review report.'],
    produces: {
      report: product.resource({ kind: 'custom.garden.review', fields: { state: 'approved' } }),
    },
    gates: [
      fieldIs({ name: 'open-pr', subject, path: 'state', value: 'open' }),
      humanGate({ name: 'review', reviewer: 'person/reviewer', review: [subject] }),
    ],
  })
  const ci = step({
    id: 'ci',
    missionId: id,
    assignedTo: owner,
    dependsOn: [completed(review)],
    goals: ['Verify CI for the supplied exact commit.'],
    gates: [
      fieldIs({
        name: 'reviewed',
        subject: review.products.report,
        path: 'state',
        value: 'approved',
      }),
      ciPassed({ name: 'build', check: 'build', repo: 'acme/garden', ref: { commit: pr.commit } }),
    ],
  })
  const land = step({
    id: 'land',
    missionId: id,
    assignedTo: owner,
    dependsOn: [completed(ci)],
    goals: ['Land the supplied PR and publish its landing receipt.'],
    produces: {
      receipt: product.field({
        subject: 'message/mission-run/${ST_MISSION_RUN}/land',
        fields: { text: 'The PR was landed.' },
      }),
    },
    gates: [merged({ name: 'merged', locator: `acme/garden#${pr.number}` })],
  })
  return mission({
    id,
    state: 'ready',
    goals: ['Review, verify and land one exact PR.'],
    steps: [review, ci, land],
    gates: [
      fieldIs({
        name: 'receipt',
        subject: land.products.receipt,
        path: 'text',
        value: 'The PR was landed.',
      }),
    ],
  })
}
