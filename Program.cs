using System.Text.Json;

var builder = WebApplication.CreateBuilder(args);
builder.Services.ConfigureHttpJsonOptions(options => options.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase);
var app = builder.Build();
app.UseDefaultFiles();
app.UseStaticFiles();
app.MapPost("/api/solve", (SolveRequest request) => Scheduler.Solve(request));
app.Run();

record Meeting(int Day, string Start, string End, int Week = 0);
record Group(string Id, string Name, string Teacher, int TeacherRating, List<Meeting> Meetings, bool Excluded = false, bool Locked = false);
record Activity(string Id, string Name, List<Group> Groups);
record SolveRequest(List<Activity> Activities, List<string> Priorities);
record ScheduleResult(List<string> GroupIds, int TeacherScore, int SaturdayCount, int GapMinutes, int StudyDays);
record SolveResponse(List<ScheduleResult> Schedules, int Examined, bool LimitReached, string? Error);

static class Scheduler
{
    const int SearchLimit = 500_000;
    static readonly string[] AllowedPriorities = ["teachers", "saturday", "gaps", "days"];

    public static SolveResponse Solve(SolveRequest? request)
    {
        if (request is null || request.Activities is null || request.Activities.Count == 0)
            return Failure("Добавьте хотя бы одну дисциплину.");
        if (request.Activities.Count > 20)
            return Failure("Поддерживается до 20 дисциплин за один расчёт.");
        if (request.Priorities is null || request.Priorities.Count != 4 ||
            request.Priorities.Distinct().Count() != 4 || request.Priorities.Any(p => !AllowedPriorities.Contains(p)))
            return Failure("Укажите каждый из четырёх приоритетов один раз.");

        var choices = new List<List<PreparedGroup>>();
        var ids = new HashSet<string>();
        var allGroupIds = new HashSet<string>();
        foreach (var activity in request.Activities)
        {
            if (string.IsNullOrWhiteSpace(activity.Id) || string.IsNullOrWhiteSpace(activity.Name) || !ids.Add(activity.Id))
                return Failure("У каждой дисциплины должны быть уникальный ID и название.");
            if (activity.Groups is null || activity.Groups.Count == 0)
                return Failure($"Добавьте группы для «{activity.Name}».");
            var prepared = new List<PreparedGroup>();
            var groupIds = new HashSet<string>();
            foreach (var group in activity.Groups)
            {
                if (string.IsNullOrWhiteSpace(group.Id) || !groupIds.Add(group.Id) || !allGroupIds.Add(group.Id) || string.IsNullOrWhiteSpace(group.Name))
                    return Failure($"Проверьте ID и названия групп для «{activity.Name}».");
                if (group.TeacherRating is < -2 or > 2 || group.Meetings is null || (!group.Excluded && group.Meetings.Count == 0))
                    return Failure($"Проверьте оценку преподавателя и занятия группы «{group.Name}».");
                var meetings = new List<Slot>();
                foreach (var meeting in group.Meetings)
                {
                    if (meeting.Day is < 1 or > 6 || meeting.Week is < 0 or > 2 || !TimeOnly.TryParseExact(meeting.Start, "HH:mm", out var start) ||
                        !TimeOnly.TryParseExact(meeting.End, "HH:mm", out var end) || start >= end)
                        return Failure($"Проверьте день и время занятий группы «{group.Name}».");
                    var first = start.Hour * 60 + start.Minute;
                    var last = end.Hour * 60 + end.Minute;
                    if (meeting.Week is 0 or 1) meetings.Add(new Slot(1, meeting.Day, first, last));
                    if (meeting.Week is 0 or 2) meetings.Add(new Slot(2, meeting.Day, first, last));
                }
                if (HasOverlap(meetings)) return Failure($"Занятия группы «{group.Name}» пересекаются.");
                if (!group.Excluded) prepared.Add(new PreparedGroup(group, meetings));
            }
            if (prepared.Count == 0) return Failure($"Все группы для «{activity.Name}» исключены.");
            if (prepared.Count(g => g.Group.Locked) > 1) return Failure($"Для «{activity.Name}» закреплено несколько групп.");
            if (prepared.Any(g => g.Group.Locked)) prepared = prepared.Where(g => g.Group.Locked).ToList();
            choices.Add(prepared);
        }

        choices.Sort((a, b) => a.Count.CompareTo(b.Count));
        var best = new List<ScheduleResult>();
        var selected = new List<PreparedGroup>();
        var occupied = new List<Slot>();
        int examined = 0;
        bool limitReached = false;

        void Search(int index)
        {
            if (examined >= SearchLimit) { limitReached = true; return; }
            if (index == choices.Count)
            {
                examined++;
                var candidate = Score(selected, occupied);
                best.Add(candidate);
                best.Sort((a, b) => Compare(a, b, request.Priorities));
                if (best.Count > 10) best.RemoveAt(best.Count - 1);
                return;
            }
            foreach (var option in choices[index])
            {
                if (option.Slots.Any(slot => occupied.Any(other => Overlaps(slot, other)))) continue;
                selected.Add(option);
                occupied.AddRange(option.Slots);
                Search(index + 1);
                occupied.RemoveRange(occupied.Count - option.Slots.Count, option.Slots.Count);
                selected.RemoveAt(selected.Count - 1);
                if (limitReached) break;
            }
        }
        Search(0);
        return new SolveResponse(best, examined, limitReached,
            best.Count == 0 ? "Не найдено расписание без пересечений. Исключите или измените конфликтующие группы." : null);
    }

    static ScheduleResult Score(List<PreparedGroup> selected, List<Slot> occupied)
    {
        int gaps = 0;
        foreach (var day in occupied.GroupBy(s => (s.Week, s.Day)))
        {
            var ordered = day.OrderBy(s => s.Start).ToList();
            for (int i = 1; i < ordered.Count; i++) gaps += ordered[i].Start - ordered[i - 1].End;
        }
        return new ScheduleResult(selected.Select(g => g.Group.Id).ToList(),
            selected.Sum(g => g.Group.TeacherRating), occupied.Count(s => s.Day == 6), gaps,
            occupied.Select(s => (s.Week, s.Day)).Distinct().Count());
    }

    static int Compare(ScheduleResult a, ScheduleResult b, List<string> priorities)
    {
        foreach (var priority in priorities)
        {
            int comparison = priority switch
            {
                "teachers" => b.TeacherScore.CompareTo(a.TeacherScore),
                "saturday" => a.SaturdayCount.CompareTo(b.SaturdayCount),
                "gaps" => a.GapMinutes.CompareTo(b.GapMinutes),
                "days" => a.StudyDays.CompareTo(b.StudyDays),
                _ => 0
            };
            if (comparison != 0) return comparison;
        }
        return string.CompareOrdinal(string.Join('|', a.GroupIds.Order()), string.Join('|', b.GroupIds.Order()));
    }

    static bool HasOverlap(List<Slot> slots) => slots.Any(a => slots.Any(b => !ReferenceEquals(a, b) && Overlaps(a, b)));
    static bool Overlaps(Slot a, Slot b) => a.Week == b.Week && a.Day == b.Day && a.Start < b.End && b.Start < a.End;
    static SolveResponse Failure(string message) => new([], 0, false, message);
    record Slot(int Week, int Day, int Start, int End);
    record PreparedGroup(Group Group, List<Slot> Slots);
}
