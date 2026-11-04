import type { Category } from '../../services/platformApi';

export type TeachingChoice = { categoryId: string; categoryName: string; subject: string; levels: string[] };
export const teachingChoiceKey = (categoryId: string, subject: string) => `${categoryId}\u0000${subject}`;
export const uniqueTeachingChoices = (choices: TeachingChoice[]) => [...new Map(choices.map(choice => [teachingChoiceKey(choice.categoryId, choice.subject), choice])).values()];
export const serializeTeachingChoices = (choices: TeachingChoice[]) => choices.map(choice => [choice.categoryName, choice.subject, choice.levels.join('، ')].filter(Boolean).join(' › ')).join(' | ');

export function parseTeachingChoices(value: string, catalog: Category[]): TeachingChoice[] {
  if (!value || !catalog.length) return [];
  // Category names themselves contain " | ". Protect them before splitting records,
  // including records saved by previous versions of the platform.
  let protectedValue = value;
  for (const category of [...catalog].sort((a, b) => b.name.length - a.name.length)) {
    protectedValue = protectedValue.replaceAll(`${category.name} › `, `\u001e${category.id}\u001e › `);
  }
  const choices: TeachingChoice[] = [];
  for (const entry of protectedValue.split(' | ').map(item => item.trim()).filter(Boolean)) {
    const parts = entry.split(' › ').map(item => item.trim());
    if (parts.length >= 2) {
      const category = catalog.find(item => parts[0] === `\u001e${item.id}\u001e` || item.name === parts[0]);
      if (!category || !category.subjects.includes(parts[1])) continue;
      const levels = parts[2] ? parts[2].split('،').map(item => item.trim()).filter(level => category.levels.includes(level)) : [];
      choices.push({ categoryId: category.id, categoryName: category.name, subject: parts[1], levels });
    } else {
      for (const category of catalog) for (const subject of category.subjects) {
        if (entry !== subject && !entry.startsWith(`${subject} - `)) continue;
        const level = entry.slice(subject.length + 3).trim();
        choices.push({ categoryId: category.id, categoryName: category.name, subject, levels: level && category.levels.includes(level) ? [level] : [...category.levels] });
      }
    }
  }
  return uniqueTeachingChoices(choices);
}
