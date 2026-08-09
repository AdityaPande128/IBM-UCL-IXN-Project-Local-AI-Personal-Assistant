---
title: "Chapter 1 — Introduction"
mainfont: "Times New Roman"
sansfont: "Times New Roman"
monofont: "Courier New"
fontsize: 12pt
geometry: margin=1in
linestretch: 1.15
---

# Chapter 1

## Introduction

### 1.1 Project Overview

This project analyses the key concepts and technical requirements behind a locally deployed,
self-extending AI assistant for personal computing. The objective is to explore how a language model
running entirely on consumer hardware can be given practical control over a user's own machine
through integration with OpenClaw, and how such an assistant can overcome the reliability limits of
small models by acquiring new capabilities over time as they are needed.

The project further explores voice and conversational interaction, and the development of a Telegram
Mini App through which the assistant can be operated remotely from a mobile device. It also examines
the evaluation methodology required to make defensible claims about a system whose behaviour is not
deterministic. The resulting application is named Jarvis.

#### 1.1.1 The Capability Accumulation Model

Cloud-hosted AI assistants are built around a fixed set of abilities: what the assistant can do is
decided by its developers and does not change in response to what any individual user asks of it. A
request outside that set is refused, regardless of how ordinary it may be.

The organising idea of this project is the opposite. When Jarvis receives a request that no installed
capability covers, it authors a new one — a small, self-contained program together with the metadata
describing how to call it — verifies that program against tests before allowing it to be used, and
registers it permanently. The user is told that no such capability exists and is asked whether one
should be built, so that the library grows deliberately rather than silently.

The first time a task is requested it is slow, because a program must be written and checked. Every
subsequent time it is fast and deterministic, because the capability is now ordinary code.

This distinction matters because of a specific limitation. A language model small enough to run on a
personal laptop is not reliable enough to be trusted with a task on a single attempt. The premise of
this project is that per-invocation reliability is the wrong requirement. Reliability is required
*once*, at the moment a capability is created and independently verified; thereafter the capability
is a deterministic artefact and the model is no longer in the execution path at all. A system that is
unreliable at generating can nevertheless be reliable at acting, provided it is rigorous about what
it accepts.

Each acquired capability is termed a *skill*, and the growing collection of skills forms a personal
library that reflects the individual user's needs rather than a vendor's assumptions about them.

#### 1.1.2 OpenClaw

OpenClaw is an open-source agent runtime. A language model on its own can only produce text. OpenClaw
gives it the means to act: it runs the model in a loop, lets it call tools such as the shell, and
reads descriptions of available capabilities from a `skills` directory. It supplies the machinery for
acting on a computer, which this project uses rather than reimplements.

What this project adds sits above that machinery: deciding what a request means, describing
capabilities in a form that can be checked, writing and verifying new ones, and constraining what
they are permitted to touch.

OpenClaw also handles a class of request that the skill system deliberately does not. A skill is a
reusable, parameterised capability, and building one is only worthwhile for tasks that recur. Many
requests are not like this — opening a particular link, asking what is running at this moment,
inspecting one unusual file. Manufacturing a permanent capability for a genuinely one-off question
would be wasted effort, so requests of this kind are passed to OpenClaw and handled directly.

Because OpenClaw can attempt the same tasks with the same model on the same machine, but with no
skill library behind it, it also serves as the baseline for the evaluation. Comparing the two makes
clear which results follow from the skill system and which were available from the runtime alone.

---

### 1.2 Problem Statement

Cloud-hosted assistants capable of operating a personal computer have advanced rapidly, but several
problems remain unaddressed for the individual user working with their own data.

**Privacy and Data Sensitivity:** The most useful tasks an assistant could perform involve precisely
the material a user is least willing to share, such as financial statements, medical documents,
academic work and personal archives. Cloud-hosted assistants require this material to be transmitted
to servers outside the user's control, and the tasks with the greatest practical value are
consequently the ones users are most reluctant to delegate.

**Third-Party Dependency and Cost:** Cloud-hosted assistants operate under usage limits, pricing and
privacy policies set by the organisation controlling them, all of which may change without the user's
consent. Self-hosted alternatives exist and provide local inference, but they do not offer autonomous
acquisition of new capabilities, nor do they enforce constraints on code they generate.

**Physical Presence:** Automating work on a personal machine generally requires being seated at that
machine. Existing tools for scripted automation demand programming knowledge and cannot be directed
in natural language from elsewhere, so the ability to act on one's own computer remains tied to
physical proximity to it.

**Static Capability:** Cloud-hosted assistants ship with a fixed set of capabilities. A request that
falls outside it is refused rather than satisfied, and the assistant does not become more capable in
response to the particular demands of the person using it. Users with recurring, individual needs are
served no better after months of use than on the first day. Where such assistants can execute code,
they do so over uploaded copies inside a remote sandbox, and cannot act on the user's own filesystem
in place.

**Reliability of Local Models:** Models small enough to run on consumer hardware are materially less
capable than hosted frontier models. Applied naively — asking the model to carry out each task afresh
on every request — a local assistant is unreliable enough to be untrustworthy for real work, which is
the principal reason local deployment is usually dismissed.

---

### 1.3 Problem Solution

The proposed solution to the problems identified in Section 1.2 is Jarvis: a locally deployed
assistant that acquires and retains verified capabilities. The problems are addressed as follows.

**Privacy and Data Sensitivity Solution:** All inference and data processing is performed on the
user's own machine using locally hosted models, and no user data is sent to any AI service. Because
no external model provider is involved, the assistant can be given access to exactly the sensitive
material that makes it useful. A distinction is drawn between the code that processes data and the
code that delivers results: automatically generated capabilities are denied network access at the
operating-system level and communicate only by writing locally, while transmission is the exclusive
responsibility of the application's own daemon. Results requested remotely necessarily transit the
messaging infrastructure used to reach the user's phone, and this trade-off is examined in Chapter
[TODO: cross-reference the security chapter].

**Third-Party Dependency and Cost Solution:** Because Jarvis runs locally and depends on no external
service, its availability and behaviour are not subject to third-party pricing or policy changes, and
it incurs no per-request cost. Automation that would be uneconomic when metered, such as frequent or
scheduled tasks, becomes practical.

**Physical Presence Solution:** The assistant is reachable both from a native desktop application and
remotely from a mobile device, and accepts spoken as well as typed instruction. Requests issued
remotely are executed on the user's own machine, decoupling the ability to act on a computer from
being physically present at it.

**Static Capability Solution:** When no installed skill covers a request, the assistant writes one. A
generated skill is subjected to static analysis and executed against test cases inside a sandbox
before it is accepted, and is registered permanently once it passes. The capability library therefore
grows in response to what an individual user actually asks for, and the system becomes measurably
more capable and more responsive with continued use. Because skills operate directly on the user's
own filesystem, tasks involving personal documents and data are carried out in place rather than on
uploaded copies.

**Reliability of Local Models Solution:** Reliability is obtained through verification rather than
through model scale. A generated capability must demonstrate correct behaviour before it is admitted;
one that fails is rejected and the failure recorded. Because verification performed by a model on its
own output is vulnerable to correlated error — a model that misunderstands a task will write tests
encoding the same misunderstanding — correctness is additionally assessed against criteria the model
never sees. Once admitted, a skill executes as deterministic code with no model involvement, so the
unreliability of generation does not propagate into use.

---

### 1.4 Project Goals

The primary goal of this project is to produce a robust, well-engineered assistant that runs entirely
on personal hardware, integrates with OpenClaw, and extends its own capabilities in response to use.

The system is required to interpret every incoming request and determine whether it can be satisfied
by an existing skill, requires a new one to be written, warrants a conversational reply, or should be
declined; and to ensure that an uncertain or malformed interpretation never results in action.
Capabilities are to be described by an explicit format carrying typed parameters, declared
permissions, and a record of their origin, so that automatically generated code is inspectable and
attributable. Generated capabilities must be verified before acceptance and constrained at execution
time to the permissions they declare.

The assistant is required to be usable by voice and by text, from the desktop and remotely, and to
converse naturally when a request calls for an answer rather than an action.

The system is to be evaluated rather than merely demonstrated: on the correctness of its
interpretation of requests, on how often generated capabilities are genuinely correct as opposed to
merely self-approved, on the effect of capability accumulation upon responsiveness, and on its
behaviour when asked to do something it should refuse.

The deliverables comprise two applications. The first is a Tauri-based native macOS application that
accepts both voice and text input, responds using the same modalities, and hosts the assistant's
backend daemon. The second is a Telegram Mini App providing remote access from a mobile device;
requests and results are relayed through the Telegram Bot API, which the macOS daemon retrieves by
polling over an outbound HTTPS connection, so that no inbound network port is exposed on the user's
machine.

The platform is designed to accommodate future development, including retrieval over a large
capability library and an independent review stage in the generation pipeline, both of which are
identified in this report as extensions warranted by the evaluation results.

---

### 1.5 Project Structure

This project follows a structured development approach, divided into Research & Design, Project
Development, and Testing & Reporting phases.

During the Research & Design phase, the focus was on requirements gathering, supervisory meetings,
background research and prototyping. Key tasks included investigating the OpenClaw agent runtime,
surveying locally deployable language models and the constraints imposed by running them on Apple
Silicon, and building experimental prototypes of the inference and agent layers.

The Project Development phase consisted of backend and frontend implementation: the request router,
the skill format and registry, the generation and verification pipeline, capability enforcement, the
desktop application, the voice pipeline and remote access. Automated testing was carried out
throughout this phase to establish the reliability of each component as it was built.

The Testing & Reporting phase centred on system-level evaluation and the preparation of
documentation, including the construction of the evaluation task suites, comparative assessment of
candidate models, and analysis of results. The project concluded with the final demonstration and
submission.

*[TODO: insert week ranges for each phase and cross-reference the Gantt chart in Appendix A.]*

---

### 1.6 Reporting Overview

This report begins by providing the necessary background on agent runtimes, locally deployable
language models and the constraints of running them on consumer hardware, alongside a review of
existing approaches to computer-using assistants. This is followed by a requirements and use case
analysis, and an outline of the overall architecture of Jarvis.

The report then moves onto the more technical aspects, beginning with the request router and the
separation of interpretation from policy, followed by the skill format, the generation and
verification pipeline, and the enforcement of declared capabilities through operating-system
sandboxing. The interface layer, covering the desktop application, the voice pipeline and remote
access, is described next.

This is followed by the evaluation, which addresses the correctness of request interpretation, the
rate at which generated capabilities are independently correct, the effect of accumulation on
responsiveness, and a comparison of candidate models for each role within the system. The report
finishes with a discussion of limitations and a conclusion.

References to the appendix are made throughout this report. Supplementary materials, including the
evaluation datasets and the full result tables, are provided alongside the report and referenced
where relevant.
