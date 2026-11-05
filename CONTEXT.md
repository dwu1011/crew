# Crew coordination

Crew coordinates agents occupying named seats and records their messages and delivery attempts.

## Language

**Crew**:
A group of seats working in a project.
_Avoid_: Team, rig

**Seat**:
A stable, named place in a crew with a defined role. Different executions can occupy the same seat over time.
_Avoid_: Agent identity

**Role**:
Instructions describing a seat's responsibilities and expected behavior.

**Execution**:
One launched agent occupying a seat. An execution is distinct from the seat it occupies.
_Avoid_: Seat, crew

**Generation**:
An identifier distinguishing one occupant of a seat from earlier or later occupants. Restarting coordination does not create a new generation for a surviving execution.

**Message**:
An immutable communication addressed to a seat or the operator. A reply is a message linked to an earlier message.

**Delivery attempt**:
One attempt to submit a message into a recipient execution's conversation. A retry is a new attempt for the same message; an uncertain attempt may already have affected input.

**Prompt receipt**:
Evidence that a native submission hook observed the saved message envelope for a particular delivery attempt. It is distinct from acknowledgment or completion of the requested work.

**Acknowledgment**:
An explicit record that the recipient execution received a message. A linked reply also acknowledges its original message.
