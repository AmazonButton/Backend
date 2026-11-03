---
name: uml-diagram-expert
description: Create, review, and improve UML State Machine Diagrams and Activity Diagrams with Swimlanes. Use when an agent needs to model object lifecycles, business workflows, decisions, parallel activities, or responsibility boundaries.
---

# UML Diagram Expert Skill

## 1. Role

Act as a UML modeling specialist. Create and review **UML State Machine Diagrams (State Diagrams)** and **UML Activity Diagrams**, with particular attention to Activity Partitions (Swimlanes).

Produce diagrams that are:
- Semantically correct according to UML 2.x conventions.
- Consistent with the stated business requirements and system behavior.
- Readable, logically complete, and maintainable.
- Suitable for software design documents and implementation reviews.
- Explicit about assumptions, missing requirements, and unresolved decisions.

Do not invent business rules, states, actors, transitions, or exception paths. If essential information is missing, ask focused clarification questions or label assumptions clearly.

## 2. Choose the correct diagram

### State Machine Diagram

Use a State Machine Diagram to describe the **lifecycle of one modeled classifier/object** and how it responds to events.

It answers:
- What states can the object be in?
- Which event causes a transition?
- What guard condition must be true?
- What action occurs during a transition or state?
- Which states are terminal, recoverable, or exceptional?

Typical subjects: Order, PaymentTransaction, WalletWithdrawal, Account, ReviewTask, Shipment.

Do not use a State Machine Diagram as a step-by-step workflow for the whole system.

### Activity Diagram

Use an Activity Diagram to describe **workflow behavior**: actions, control flow, decisions, parallel work, and data/object flow.

It answers:
- What work is performed?
- In what order?
- Who or which component performs each action?
- Where can the workflow branch?
- Which actions can run concurrently?
- Where do alternative or parallel paths merge?

Use Swimlanes when responsibility boundaries matter.

Do not use an Activity Diagram as a substitute for an object's lifecycle model.

### When both are needed

Use both when a workflow changes the lifecycle of an important entity:
- Activity Diagram: explains the process and responsibility of each participant.
- State Machine Diagram: explains the legal lifecycle and transitions of the entity.

Keep the two diagrams consistent. An Activity action such as `Approve Withdrawal` may trigger a State transition such as `Pending -> Approved`, but the action and state are not the same concept.

## 3. State Machine Diagram rules

### 3.1 Core notation

| Element | UML notation | Meaning |
|---|---|---|
| Initial pseudostate | Filled black circle | Entry point of a region |
| State | Rounded rectangle | Condition or situation during the object's lifecycle |
| Transition | Directed line with arrowhead | Movement between vertices |
| Final state | Filled black circle surrounded by an outer circle | Completion of the state machine/region |
| Choice pseudostate | Diamond | Dynamic conditional branching |
| Junction pseudostate | Diamond | Static branching/merging of transitions |
| Composite state | State containing nested regions/states | Hierarchical state structure |
| Shallow history | Circle with `H` | Restore most recently active direct substate |
| Deep history | Circle with `H*` | Restore most recently active nested state configuration |

Use advanced pseudostates only when they add meaningful clarity.

### 3.2 State naming

- Name states as conditions or situations, usually nouns/adjectives or concise status labels.
- Prefer `Pending`, `Processing`, `Approved`, `Rejected`, `Completed`, `Cancelled`, `Expired`.
- Avoid naming a state as an imperative action: `Approve Order`, `Send Payment`, `Create Account`.
- Use the same terminology as the domain model and database enum/check constraint when the diagram represents implemented software.
- Distinguish states that have different business meanings.
- Do not create a state for every small operation. Model meaningful lifecycle conditions.

### 3.3 Transition syntax

Use the UML transition label convention:

```text
trigger [guard] / effect
```

Where:
- `trigger`: event or trigger that enables the transition.
- `[guard]`: optional Boolean condition that must be true.
- `/ effect`: optional behavior executed as part of the transition.

Example:

```text
submitPayment [amount > 0] / createPaymentSession
```

Rules:
- Use an arrow to show direction.
- Name triggers as events, commonly verb phrases or event names: `paymentReceived`, `approve`, `timeout`.
- Put guard conditions in square brackets.
- Put transition effects after `/`.
- A guard is a condition, not an action.
- An effect is behavior, not the resulting state name.
- Ensure outgoing alternatives are logically understandable and do not overlap unintentionally.
- If a transition is unconditional, do not add a fake guard.
- Do not label a transition with a vague phrase such as `process` when a specific event is known.

### 3.4 State behavior

UML state compartments may contain:

```text
entry / action
do / activity
exit / action
```

- `entry`: behavior executed when entering the state.
- `do`: activity performed while the state is active.
- `exit`: behavior executed when leaving the state.

Do not confuse entry/do/exit behavior with transition triggers or transition effects.

### 3.5 Lifecycle completeness and correctness

Check that:
- The initial pseudostate and valid initial transition are present.
- Every normal state is reachable unless intentionally unreachable and explained.
- Each state has meaningful incoming/outgoing transitions, unless it is intentionally terminal or waiting.
- Success, failure, cancellation, rejection, expiration, and timeout paths are included when relevant to the requirements.
- Recovery/retry paths are modeled only when the business rules allow them.
- Terminal states are clearly identified.
- A terminal state is not given outgoing transitions unless the model intentionally represents a different region or uses a valid UML construct.
- Events and guards represent possible system behavior.
- There are no contradictory, duplicate, or impossible transitions.
- The model distinguishes a pending/waiting state from a completed state.
- External callbacks, user actions, scheduled jobs, and system events are distinguished when this affects behavior.

Do not assume that `Failed`, `Cancelled`, or `Expired` are always final. Confirm whether retry, reopening, refund, or reversal is allowed.

### 3.6 Advanced state modeling

Use only when required:
- **Composite State:** group related substates under a parent state.
- **Orthogonal Regions:** model concurrent state regions within a composite state.
- **Entry/Exit/Do behavior:** describe state-bound behavior.
- **History pseudostates:** resume a previously active substate configuration.
- **Choice:** select a path based on runtime guards.
- **Junction:** connect or combine transition paths.
- **Internal transition:** handle an event without leaving the current state.
- **Self-transition:** leave and re-enter the same state when that behavior is intended.

Do not use a choice node as a replacement for an ordinary transition when no branching is needed.

## 4. Activity Diagram rules

### 4.1 Core notation

| Element | UML notation | Meaning |
|---|---|---|
| Initial node | Filled black circle | Start of an activity |
| Action | Rounded rectangle | Executable unit of work |
| Control flow | Directed arrow | Ordering of execution |
| Decision node | Diamond | Select an outgoing path using guards |
| Merge node | Diamond | Recombine alternative paths |
| Fork node | Thick bar | Split one flow into concurrent flows |
| Join node | Thick bar | Synchronize concurrent flows |
| Activity final | Bullseye symbol | End the entire activity |
| Flow final | Circle with `X` | End one flow without ending the whole activity |
| Object node | Rectangle | Data/object used or produced |
| Object flow | Directed arrow | Movement of data/object between actions |
| Activity partition | Swimlane/partition region | Responsibility grouping |

### 4.2 Action naming

- Name actions with a clear verb + object phrase.
- Prefer `Validate Order`, `Calculate Total`, `Reserve Inventory`, `Create Payment Session`, `Update Order Status`.
- Avoid vague labels such as `Process`, `Handle`, `Do Work`, or `Check` without an object or purpose.
- Avoid naming actions only with a state or entity name, such as `Payment` or `Order`.
- Keep each action at a consistent level of detail.
- Split an action only when its internal steps matter to the workflow being documented.

### 4.3 Control flow

- Use directed arrows to show execution order.
- Ensure the flow is connected from the initial node to valid completion paths.
- Avoid accidental dead ends and unreachable actions.
- Show loops explicitly when work can repeat.
- Use a decision node for conditional alternatives.
- Do not use a decision node to represent concurrency.
- Keep control-flow crossings and long connector lines to a minimum.
- Do not imply that an action is performed by a participant unless its partition makes responsibility clear.

### 4.4 Decision and merge

**Decision node**
- One incoming flow and multiple outgoing alternatives in the usual case.
- Put a guard on each outgoing alternative, such as `[valid]`, `[invalid]`, `[approved]`, `[rejected]`.
- Guards should be mutually exclusive where the alternatives are intended to be exclusive.
- Cover all expected outcomes.
- Use `[else]` when a clear default path is appropriate.
- Do not leave a required branch without a condition.

**Merge node**
- Recombine alternative paths.
- Does not synchronize concurrent work.
- Use it after alternative branches when the paths continue as one flow.

### 4.5 Fork and join

**Fork**
- Splits one incoming flow into multiple concurrent flows.
- Use only when activities may proceed concurrently.
- Do not use it to represent alternatives.

**Join**
- Synchronizes concurrent incoming flows.
- A join generally waits for the required incoming flows according to its join semantics.
- Use it when subsequent work must wait for concurrent work to complete.
- Consider whether every incoming path can actually be activated; avoid unintended deadlocks.
- Do not use a join to recombine mutually exclusive decision branches.

### 4.6 Activity final and flow final

- **Activity Final:** terminates the entire activity, including active flows.
- **Flow Final:** terminates only the flow reaching it; other concurrent flows may continue.
- Choose the correct final node based on the intended semantics.
- Do not use a flow final when the whole process must stop.
- Do not use an activity final when independent concurrent work must continue.

### 4.7 Object flow and data

- Use object nodes/object flows when data movement is important to understanding the process.
- Label the data object clearly, for example `Order Data`, `Payment Result`, `Validated Request`.
- Use object flow to show data passed between actions.
- Do not confuse object flow with control flow.
- Avoid drawing every minor variable or implementation detail.
- Model important inputs, outputs, and data dependencies only.

## 5. Swimlane (Activity Partition) rules

### 5.1 Purpose

A Swimlane identifies **who or what is responsible for an action**. A partition may represent:
- A human actor: `Customer`, `Admin`, `Store Owner`.
- A team or department: `Warehouse`, `Accounting`, `Support`.
- A software component: `Mobile App`, `Frontend`, `Backend API`.
- An external system: `Payment Gateway`, `Bank`, `Identity Provider`.

Choose the partitioning approach based on the diagram's purpose. Do not mix business roles and technical components without a clear reason.

### 5.2 Partition rules

- Give every partition a clear, unique, meaningful name.
- Place each action in the partition responsible for performing it.
- Do not place an action in a lane merely because that participant receives its result.
- Control flows may cross partition boundaries.
- A cross-lane flow should make handoffs and responsibility changes understandable.
- Use the same naming for participants throughout the diagram and related documentation.
- Do not create one lane per action.
- Avoid excessive partitions; group responsibilities when appropriate.
- Keep all partitions within one coherent activity/process.
- The initial and final nodes should be placed consistently with the chosen layout and process ownership.
- Do not use partitions to represent entity states, database tables, or arbitrary phases.
- If a task is jointly performed, clarify the responsibility or model the collaboration explicitly rather than placing it ambiguously.

### 5.3 Choosing the right level of Swimlane detail

For a business-level workflow, prefer lanes such as:

```text
Customer | System | Payment Provider
```

For a technical interaction workflow, a more detailed partitioning may be appropriate:

```text
Customer | Mobile App | Backend API | Payment Gateway | Bank
```

Do not split `Frontend` and `Backend` unless their interaction is relevant to the question being answered.

### 5.4 Cross-lane handoffs

When responsibility moves between lanes:
- Show the control flow crossing the lane boundary.
- Make the receiving action explicit.
- Avoid ambiguous arrows that appear to skip a participant.
- If a request/response interaction matters, model both directions or the relevant response path.
- Do not assume that a third-party system synchronously responds if the actual integration uses webhooks or asynchronous callbacks.

## 6. State Diagram vs Activity Diagram

| Concern | State Machine Diagram | Activity Diagram |
|---|---|---|
| Primary focus | Object lifecycle | Workflow |
| Main element | State | Action |
| Transition/flow meaning | Event changes state | Control moves to next action |
| Conditional construct | Guard on transition / Choice | Decision node with guarded flows |
| Parallel behavior | Orthogonal regions | Fork and Join |
| Responsibility lanes | Not normally used | Swimlanes/partitions |
| Main question | What state is the object in? | Who does what, and in what order? |

Do not model an action as a state or a state as an action merely to make the diagrams look similar.

## 7. Cross-diagram consistency

When producing both diagrams for the same feature:
- Use consistent entity, actor, event, and status names.
- Ensure Activity actions that change an entity's status correspond to valid State Machine transitions.
- Do not introduce a status in the Activity Diagram that is absent from the agreed lifecycle model.
- Do not invent a State Machine transition that no event or process can trigger.
- Ensure error, cancellation, retry, timeout, and asynchronous callback behavior agree across diagrams.
- Check that the modeled workflow respects authorization and responsibility boundaries.
- If database status values are supplied, preserve their exact spelling and allowed values.
- Distinguish a technical payment-session status from an order, wallet, or withdrawal status.

## 8. Layout and readability rules

- Prefer top-to-bottom or left-to-right flow and remain consistent within one diagram.
- Keep spacing and alignment consistent.
- Minimize crossing, overlapping, and unnecessarily long connectors.
- Use concise labels.
- Keep the abstraction level consistent.
- Avoid excessive colors, icons, decorations, and visual effects.
- Use color only when it has a consistent meaning and is explained.
- Split an oversized diagram into focused sub-processes or related diagrams.
- Give every diagram a descriptive title and define its scope.
- Include a legend only when non-standard styling or notation is used.
- Do not omit meaningful exception paths merely to make the diagram visually simple.

## 9. Common modeling mistakes

### State Machine mistakes
- Modeling a workflow instead of an object's lifecycle.
- Using action names as state names.
- Treating events as states.
- Omitting important failure, cancellation, timeout, or expiration paths.
- Leaving guards ambiguous or contradictory.
- Creating unreachable states or impossible transitions.
- Treating every failure state as terminal without checking retry/recovery rules.

### Activity Diagram mistakes
- Using a decision node for parallel execution.
- Using a fork for mutually exclusive alternatives.
- Using a merge to synchronize parallel flows.
- Using a join to combine alternative paths.
- Omitting guards on conditional branches.
- Creating dead ends or unreachable actions unintentionally.
- Using an activity final when only one concurrent flow should end, or vice versa.

### Swimlane mistakes
- Placing actions in the wrong participant's lane.
- Using unclear or inconsistent lane names.
- Creating too many lanes.
- Mixing business actors and technical components without a defined modeling purpose.
- Using lanes as process phases or entity states.
- Hiding handoffs between participants.

## 10. Agent workflow

When asked to create or review a UML diagram, follow this workflow:
- Step 1: Understand the request.
- Step 2: Inspect supplied sources.
- Step 3: Build the model before drawing.
- Step 4: Generate the diagram.
- Step 5: Validate against checklists.
- Step 6: Present the result.

## 11. State Machine review checklist
- [ ] Scope is one entity/classifier lifecycle.
- [ ] Initial pseudostate is present.
- [ ] State names describe conditions, not commands.
- [ ] All meaningful states are identified.
- [ ] Transition arrows have correct directions.
- [ ] Triggers/events are explicit where needed.
- [ ] Guards use square brackets and express Boolean conditions.
- [ ] Effects are distinguished from triggers and states (`trigger [guard] / effect`).
- [ ] Outgoing alternatives are logically consistent.
- [ ] Required success and exception paths are modeled.
- [ ] Retry/recovery behavior follows actual business rules.
- [ ] Terminal states are correctly identified.
- [ ] Reachability and dead-end states have been checked.
- [ ] Names agree with the domain model/database where applicable.

## 12. Activity Diagram review checklist
- [ ] Scope is one coherent workflow.
- [ ] Initial node is present.
- [ ] Actions use verb + object naming.
- [ ] Control flows have clear directions.
- [ ] Decision branches have guards.
- [ ] Expected alternatives are covered.
- [ ] Merge is used for alternative paths.
- [ ] Fork is used for concurrent paths.
- [ ] Join is used to synchronize concurrent paths.
- [ ] Activity Final and Flow Final are used correctly.
- [ ] Important object/data flows are represented.
- [ ] Swimlanes have clear and consistent names.
- [ ] Every action is in the responsible lane.
- [ ] Cross-lane handoffs are understandable.
- [ ] All expected paths reach a valid outcome.
- [ ] Loops and exception paths are explicit.
- [ ] Layout is readable and abstraction level is consistent.

## 13. Output expectations
- Explain which diagram type is appropriate and why.
- Use standard UML terminology.
- Provide Mermaid source when useful.
- Keep labels concise and consistent.
- Separate confirmed requirements from assumptions.
- Never fabricate actors, states, events, guards, status values, or system behavior.

