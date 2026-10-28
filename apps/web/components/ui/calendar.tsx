"use client";

import * as React from "react";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
} from "lucide-react";
import {
  DayPicker,
  getDefaultClassNames,
  type DayPickerProps,
} from "react-day-picker";

import { cn } from "@usemoney/utils";
import { Button, buttonVariants } from "@usemoney/ui/button";

interface CalendarProps {
  className?: string;
  classNames?: Partial<DayPickerProps["classNames"]>;
  showOutsideDays?: boolean;
  captionLayout?: "label" | "dropdown" | "dropdown-months" | "dropdown-years";
  buttonVariant?:
    | "default"
    | "destructive"
    | "outline"
    | "secondary"
    | "ghost"
    | "link";
  formatters?: Partial<DayPickerProps["formatters"]>;
  components?: Partial<DayPickerProps["components"]>;
}

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  captionLayout = "label",
  buttonVariant = "ghost",
  formatters,
  components,
  showYearNavigation = false,
  ...props
}: CalendarProps & Partial<DayPickerProps> & { showYearNavigation?: boolean }) {
  const defaultClassNames = getDefaultClassNames();

  return (
    <DayPicker
      {...({
        ...props,
        showOutsideDays,
        className: cn(
          "bg-background group/calendar p-3 [--cell-size:2rem] [[data-slot=card-content]_&]:bg-transparent [[data-slot=popover-content]_&]:bg-transparent",
          String.raw`rtl:**:[.rdp-button\_next>svg]:rotate-180`,
          String.raw`rtl:**:[.rdp-button\_previous>svg]:rotate-180`,
          className
        ),
        captionLayout,
        formatters: {
          formatMonthDropdown: (date: Date) =>
            date.toLocaleString("default", { month: "short" }),
          ...formatters,
        },
        classNames: {
          root: cn("w-fit", defaultClassNames.root),
          months: cn(
            "relative flex flex-col gap-4 md:flex-row",
            defaultClassNames.months
          ),
          month: cn("flex w-full flex-col gap-4", defaultClassNames.month),
          nav: cn(
            "absolute inset-x-0 top-0 flex w-full items-center justify-between gap-1",
            showYearNavigation && "px-1",
            defaultClassNames.nav
          ),
          button_previous: cn(
            buttonVariants({ variant: buttonVariant }),
            "h-[--cell-size] w-[--cell-size] select-none p-0 aria-disabled:opacity-50",
            defaultClassNames.button_previous
          ),
          button_next: cn(
            buttonVariants({ variant: buttonVariant }),
            "h-[--cell-size] w-[--cell-size] select-none p-0 aria-disabled:opacity-50",
            defaultClassNames.button_next
          ),
          month_caption: cn(
            "flex h-[--cell-size] w-full items-center justify-center px-[--cell-size]",
            defaultClassNames.month_caption
          ),
          dropdowns: cn(
            "flex h-[--cell-size] w-full items-center justify-center gap-1.5 text-sm font-medium",
            defaultClassNames.dropdowns
          ),
          dropdown_root: cn(
            "has-focus:border-ring border-input shadow-xs has-focus:ring-ring/50 has-focus:ring-[3px] relative rounded-md border",
            defaultClassNames.dropdown_root
          ),
          dropdown: cn(
            "absolute inset-0 opacity-0",
            defaultClassNames.dropdown
          ),
          caption_label: cn(
            "select-none font-medium",
            captionLayout === "label"
              ? "text-sm"
              : "[&>svg]:text-muted-foreground flex h-8 items-center gap-1 rounded-md pl-2 pr-1 text-sm [&>svg]:size-3.5",
            defaultClassNames.caption_label
          ),
          table: "w-full border-collapse",
          weekdays: cn("flex", defaultClassNames.weekdays),
          weekday: cn(
            "text-muted-foreground flex-1 select-none rounded-md text-[0.8rem] font-normal",
            defaultClassNames.weekday
          ),
          week: cn("mt-2 flex w-full", defaultClassNames.week),
          week_number_header: cn(
            "w-[--cell-size] select-none",
            defaultClassNames.week_number_header
          ),
          week_number: cn(
            "text-muted-foreground select-none text-[0.8rem]",
            defaultClassNames.week_number
          ),
          day: cn(
            "group/day relative aspect-square h-full w-full select-none p-0 text-center [&:first-child[data-selected=true]_button]:rounded-l-md [&:last-child[data-selected=true]_button]:rounded-r-md",
            defaultClassNames.day
          ),
          range_start: cn(
            "bg-accent rounded-l-md",
            defaultClassNames.range_start
          ),
          range_middle: cn("rounded-none", defaultClassNames.range_middle),
          range_end: cn("bg-accent rounded-r-md", defaultClassNames.range_end),
          today: cn(
            "bg-accent text-accent-foreground rounded-md data-[selected=true]:rounded-none",
            defaultClassNames.today
          ),
          outside: cn(
            "text-muted-foreground aria-selected:text-muted-foreground",
            defaultClassNames.outside
          ),
          disabled: cn(
            "text-muted-foreground opacity-50",
            defaultClassNames.disabled
          ),
          hidden: cn("invisible", defaultClassNames.hidden),
          ...classNames,
        },
        components: {
          Root: ({
            className,
            rootRef,
            ...props
          }: React.ComponentPropsWithoutRef<"div"> & {
            rootRef?: React.Ref<HTMLDivElement>;
          }) => {
            return (
              <div
                data-slot="calendar"
                ref={rootRef}
                className={cn(className)}
                {...props}
              />
            );
          },
          Chevron: ({
            className,
            orientation,
            ...props
          }: {
            className?: string;
            size?: number;
            disabled?: boolean;
            orientation?: "left" | "right" | "down" | "up";
          }) => {
            if (orientation === "left") {
              return (
                <ChevronLeftIcon
                  className={cn("size-4", className)}
                  {...props}
                />
              );
            }

            if (orientation === "right") {
              return (
                <ChevronRightIcon
                  className={cn("size-4", className)}
                  {...props}
                />
              );
            }

            return (
              <ChevronDownIcon className={cn("size-4", className)} {...props} />
            );
          },
          DayButton: CalendarDayButton,
          WeekNumber: ({
            children,
            ...props
          }: React.TdHTMLAttributes<HTMLTableCellElement>) => {
            return (
              <td {...props}>
                <div className="flex size-[--cell-size] items-center justify-center text-center">
                  {children}
                </div>
              </td>
            );
          },
          ...components,
        },
      } as DayPickerProps)}
    />
  );
}

interface CalendarDayButtonProps extends React.ComponentPropsWithoutRef<
  typeof Button
> {
  className?: string;
  day: { date: Date };
  modifiers: {
    selected?: boolean;
    range_start?: boolean;
    range_end?: boolean;
    range_middle?: boolean;
    focused?: boolean;
  };
}

function CalendarDayButton({
  className,
  day,
  modifiers,
  ...props
}: CalendarDayButtonProps) {
  const defaultClassNames = getDefaultClassNames();

  const ref = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    if (modifiers.focused) ref.current?.focus();
  }, [modifiers.focused]);

  return (
    <Button
      ref={ref}
      variant="ghost"
      size="icon"
      data-day={day.date.toLocaleDateString()}
      data-selected-single={
        modifiers.selected &&
        !modifiers.range_start &&
        !modifiers.range_end &&
        !modifiers.range_middle
      }
      data-range-start={modifiers.range_start}
      data-range-end={modifiers.range_end}
      data-range-middle={modifiers.range_middle}
      className={cn(
        "data-[selected-single=true]:bg-primary data-[selected-single=true]:text-primary-foreground data-[range-middle=true]:bg-accent data-[range-middle=true]:text-accent-foreground data-[range-start=true]:bg-primary data-[range-start=true]:text-primary-foreground data-[range-end=true]:bg-primary data-[range-end=true]:text-primary-foreground group-data-[focused=true]/day:border-ring group-data-[focused=true]/day:ring-ring/50 flex aspect-square h-auto w-full min-w-[--cell-size] flex-col gap-1 font-normal leading-none data-[range-end=true]:rounded-md data-[range-middle=true]:rounded-none data-[range-start=true]:rounded-md group-data-[focused=true]/day:relative group-data-[focused=true]/day:z-10 group-data-[focused=true]/day:ring-[3px] [&>span]:text-xs [&>span]:opacity-70",
        defaultClassNames.day,
        className
      )}
      {...props}
    />
  );
}

// Calendar with Year Navigation (double arrows for year, single for month)
interface CalendarWithYearNavProps extends Omit<
  CalendarProps,
  "month" | "onMonthChange"
> {
  selected?: Date;
  onSelect?: (date: Date | undefined) => void;
  disabled?: DayPickerProps["disabled"];
  mode?: "single" | "multiple" | "range";
  initialFocus?: boolean;
}

function CalendarWithYearNav({
  selected,
  onSelect,
  disabled,
  mode = "single",
  initialFocus,
  className,
  ...props
}: CalendarWithYearNavProps) {
  const [currentMonth, setCurrentMonth] = React.useState<Date>(
    selected || new Date()
  );

  const goToPreviousYear = () => {
    setCurrentMonth((prev) => {
      const newDate = new Date(prev);
      newDate.setFullYear(newDate.getFullYear() - 1);
      return newDate;
    });
  };

  const goToNextYear = () => {
    setCurrentMonth((prev) => {
      const newDate = new Date(prev);
      newDate.setFullYear(newDate.getFullYear() + 1);
      return newDate;
    });
  };

  const goToPreviousMonth = () => {
    setCurrentMonth((prev) => {
      const newDate = new Date(prev);
      newDate.setMonth(newDate.getMonth() - 1);
      return newDate;
    });
  };

  const goToNextMonth = () => {
    setCurrentMonth((prev) => {
      const newDate = new Date(prev);
      newDate.setMonth(newDate.getMonth() + 1);
      return newDate;
    });
  };

  const formatMonthYear = (date: Date) => {
    return date.toLocaleDateString("en-US", {
      month: "short",
      year: "numeric",
    });
  };

  return (
    <div className={cn("p-3", className)}>
      {/* Custom Navigation Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={goToPreviousYear}
            title="Previous Year"
          >
            <ChevronsLeftIcon className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={goToPreviousMonth}
            title="Previous Month"
          >
            <ChevronLeftIcon className="h-4 w-4" />
          </Button>
        </div>
        <span className="text-sm font-medium select-none">
          {formatMonthYear(currentMonth)}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={goToNextMonth}
            title="Next Month"
          >
            <ChevronRightIcon className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={goToNextYear}
            title="Next Year"
          >
            <ChevronsRightIcon className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Calendar without default nav */}
      <DayPicker
        mode={mode as "single"}
        selected={selected}
        onSelect={onSelect as (date: Date | undefined) => void}
        month={currentMonth}
        onMonthChange={setCurrentMonth}
        disabled={disabled}
        showOutsideDays
        initialFocus={initialFocus}
        classNames={{
          months: "flex flex-col",
          month: "space-y-2",
          month_caption: "hidden", // Hide default caption since we have custom nav
          nav: "hidden", // Hide default nav since we have custom nav
          month_grid: "w-full border-collapse",
          weekdays: "flex w-full",
          weekday:
            "text-muted-foreground w-8 font-normal text-[0.8rem] text-center flex-1",
          week: "flex w-full mt-1",
          day: "text-center text-sm relative p-0 focus-within:relative focus-within:z-20 flex-1 flex items-center justify-center",
          day_button: cn(
            buttonVariants({ variant: "ghost" }),
            "h-8 w-8 p-0 font-normal aria-selected:opacity-100"
          ),
          selected:
            "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground focus:bg-primary focus:text-primary-foreground rounded-md",
          today: "bg-accent text-accent-foreground rounded-md",
          outside: "text-muted-foreground opacity-50",
          disabled: "text-muted-foreground opacity-50",
          hidden: "invisible",
        }}
        {...props}
      />
    </div>
  );
}

export { Calendar, CalendarDayButton, CalendarWithYearNav };
