# taxis

This repository should contain an issue tracker built in Lean4.

## Concepts

### Actors

An actor is someone assigned to or responsible for an issue, e.g. a human contributor or a bot.
It consists of

- unique identifier
- email address
- display name
- possibly empty list of groups
- possibly linked google account to authenticate against

Not every actor can authenticate against the backend.

### Groups

A group is a group of actors and serves as permission filter.

### Issues

An issue consists of

- unique identifier
- title
- description
- possibly empty set of parent issues
- meta data such as a label
- assigned / responsible actors
- attached artifacts
- visibility by group (question: inheritance of visibility?)
- open / closed / completed
- attached checks

### Artifacts

An artifact is something attached to an issue, e.g. a pull request on github, a branch
on a github repository.

Which artifacts are possible should be extensible by the user.

### Checks

A check is a condition on the issue and its attached artifacts: For example if a certain
CI run passes on an attached branch. This also needs to be extensible.

## Technical background

The tracker should be split in two components:

- a REST API backend
- a frontend

Both components need to be extensible (by a plugin system?), to support new artifacts.

## Frontend

- The frontend should be dynamic and can be implemented in typescript, but in the same repository.

## Backend

- Lean has a HTTP server library that can be used to provide the REST API backend.
- The (de)serialisation should be done using many custom structures and simple JSON <-> data
  conversions.
- The data should be stored in a database.
- The querying of issues needs to be fast.

## Further features

### Backend

- Import: e.g. github issues, google docs by line
- Future: authentication against other sources, e.g., an internal password

### Frontend

- Graph display of all issues with their dependencies
